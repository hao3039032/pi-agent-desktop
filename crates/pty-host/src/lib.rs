//! # pty-host — portable-pty terminals for the Rust desktop host
//!
//! M0 PoC of the plan's PTY semantics (§六 PTY 与调度; docs/terminal.md is
//! the behavioral reference of the node-pty implementation):
//!
//! - **idempotent create**: the same id (and cwd) returns the running PTY,
//!   never a second one — React Strict Mode's repeated mounts rely on this;
//! - **serialized input/resize**: writes and resizes on one PTY are ordered;
//! - **bounded UTF-16 history + cursor**: at most [`HISTORY_LIMIT_UNITS`]
//!   UTF-16 code units are retained; a reader presenting an OLDER cursor
//!   (fell out of the retained window) is answered with a terminal reset +
//!   bounded replay instead of a partial suffix; a current cursor gets the
//!   missing suffix only;
//! - **no input auto-retry**: a failed write is an error surfaced to the
//!   caller (re-sending terminal input can duplicate a command);
//! - **exit code**: `wait` reports the child's exit status; cleanup kills
//!   the process group on drop.
//!
//! The 120-second connection lease, SSE/Channel subscriptions and xterm
//! wiring are M4; what this crate freezes is the PTY semantics underneath.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};

/// Retained history cap, in UTF-16 code units (docs/terminal.md: 128 KiB).
pub const HISTORY_LIMIT_UNITS: usize = 128 * 1024;

type LogFn = Arc<dyn Fn(String) + Send + Sync>;

/// Options for [`PtyHost::create`].
pub struct PtyOptions {
    /// Columns/rows of the initial window.
    pub cols: u16,
    pub rows: u16,
    /// Environment additions over the inherited environment.
    pub env: Vec<(String, String)>,
    /// Diagnostics (spawn trouble, read errors).
    pub on_log: Option<LogFn>,
}

impl Default for PtyOptions {
    fn default() -> Self {
        Self { cols: 80, rows: 24, env: Vec::new(), on_log: None }
    }
}

/// The outcome of reading output since a cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadOutcome {
    /// The missing suffix since the given cursor.
    Suffix {
        /// The cursor after this read (exclusive end).
        cursor: u64,
        /// The output as a string (UTF-16-unit-addressed prefix omitted).
        text: String,
    },
    /// The cursor fell out of the retained history: the client must reset
    /// its terminal and replay `text` from scratch.
    Reset { cursor: u64, text: String },
}

struct History {
    /// Retained text (a UTF-16-unit window of the stream).
    text: String,
    /// UTF-16 units dropped from the front of `text` (the cursor value of
    /// `text`'s first unit is `dropped_units`).
    dropped_units: u64,
    /// Total units ever written = the exclusive-end cursor for new readers.
    total_units: u64,
}

impl History {
    fn new() -> Self {
        Self { text: String::new(), dropped_units: 0, total_units: 0 }
    }

    fn push(&mut self, chunk: &str) {
        self.text.push_str(chunk);
        self.total_units += chunk.encode_utf16().count() as u64;
        // Trim to the cap, on a char boundary, counting dropped UTF-16 units.
        let units: usize = self.text.encode_utf16().count();
        if units > HISTORY_LIMIT_UNITS {
            let mut keep_units = HISTORY_LIMIT_UNITS;
            // Never split a surrogate pair or a multi-byte char.
            let mut char_indices: Vec<usize> = self.text.char_indices().map(|(i, _)| i).collect();
            char_indices.push(self.text.len());
            // Find the byte index from which exactly <= keep_units units remain.
            let mut drop_bytes = 0;
            let mut dropped = 0usize;
            let mut idx = 0;
            while idx + 1 < char_indices.len() {
                let c = self.text[char_indices[idx]..char_indices[idx + 1]].chars().next().unwrap();
                let c_units = c.len_utf16();
                if units - dropped - c_units >= keep_units {
                    dropped += c_units;
                    drop_bytes = char_indices[idx + 1];
                } else {
                    break;
                }
                idx += 1;
            }
            let _ = &mut keep_units;
            self.dropped_units += dropped as u64;
            self.text.replace_range(0..drop_bytes, "");
        }
    }

    /// The exclusive-end cursor (total units written so far).
    fn end_cursor(&self) -> u64 {
        self.total_units
    }

    /// Read everything after `cursor` (a UTF-16-unit offset). A cursor older
    /// than the retained window triggers a reset + full replay.
    fn read_since(&self, cursor: u64) -> ReadOutcome {
        let end = self.total_units;
        if cursor >= end {
            return ReadOutcome::Suffix { cursor: end, text: String::new() };
        }
        if cursor < self.dropped_units {
            // Out of the window: reset + bounded replay.
            return ReadOutcome::Reset { cursor: end, text: self.text.clone() };
        }
        // Offset into `text` in UTF-16 units.
        let offset_units = (cursor - self.dropped_units) as usize;
        let mut unit_index = 0usize;
        let mut byte_index = 0usize;
        for (i, c) in self.text.char_indices() {
            if unit_index >= offset_units {
                byte_index = i;
                break;
            }
            unit_index += c.len_utf16();
            byte_index = i + c.len_utf16();
        }
        ReadOutcome::Suffix { cursor: end, text: self.text[byte_index..].to_string() }
    }
}

/// One running PTY.
pub struct Pty {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    history: Mutex<History>,
    /// Serialized input/resize queue: writers hold this while writing.
    io_lock: Mutex<()>,
    exit: Mutex<Option<ExitState>>,
    exit_cv: Condvar,
    master: Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
    log: LogFn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ExitState {
    Exited(i32),
    Signaled,
}

impl Pty {
    /// Write input to the child. Failures surface as errors — terminal input
    /// is never auto-retried (a re-send can duplicate a command).
    pub fn write_input(&self, bytes: &[u8]) -> Result<(), String> {
        let _guard = self.io_lock.lock().unwrap();
        let mut writer = self.writer.lock().unwrap();
        let Some(writer) = writer.as_mut() else {
            return Err("the terminal input is closed".to_string());
        };
        writer.write_all(bytes).and_then(|()| writer.flush()).map_err(|error| {
            (self.log)(format!("pty input failed: {error}"));
            format!("pty input failed: {error}")
        })
    }

    /// Resize the PTY window.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let _guard = self.io_lock.lock().unwrap();
        let master = self.master.lock().unwrap();
        let Some(master) = master.as_ref() else {
            return Err("the terminal is closed".to_string());
        };
        master
            .resize(portable_pty::PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })
            .map_err(|error| format!("pty resize failed: {error}"))
    }

    /// Read output after a UTF-16-unit cursor (see [`ReadOutcome`]).
    pub fn read_since(&self, cursor: u64) -> ReadOutcome {
        self.history.lock().unwrap().read_since(cursor)
    }

    /// The current exclusive-end cursor.
    pub fn cursor(&self) -> u64 {
        self.history.lock().unwrap().end_cursor()
    }

    /// Wait for the child to exit; returns the exit code (`None` when it
    /// died by a signal).
    pub fn wait_exit(&self, timeout: std::time::Duration) -> Option<Option<i32>> {
        let deadline = std::time::Instant::now() + timeout;
        let mut state = self.exit.lock().unwrap();
        while state.is_none() {
            let now = std::time::Instant::now();
            if now >= deadline {
                return None;
            }
            let (guard, _) = self.exit_cv.wait_timeout(state, deadline - now).unwrap();
            state = guard;
        }
        match *state {
            Some(ExitState::Exited(code)) => Some(Some(code)),
            Some(ExitState::Signaled) => Some(None),
            None => None,
        }
    }

}

/// The registry of running PTYs. Create is idempotent by id.
pub struct PtyHost {
    inner: Arc<Mutex<HashMap<String, Arc<Pty>>>>,
}

impl Default for PtyHost {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyHost {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// Create (or return the existing) PTY with this id. A live PTY with the
    /// same id is returned as-is — including a different cwd: the original
    /// terminal keeps its folder (the id is the identity).
    pub fn create(&self, id: &str, cwd: Option<&std::path::Path>, options: PtyOptions) -> Result<Arc<Pty>, String> {
        // The whole open→spawn→insert runs under ONE lock: without it, two
        // concurrent creates for the same id both pass the existence check,
        // both spawn a shell, and the loser's child is orphaned (it is in no
        // registry, so close() can never reach it).
        let mut map = self.inner.lock().unwrap();
        if let Some(existing) = map.get(id) {
            if existing.exit.lock().unwrap().is_none() {
                return Ok(Arc::clone(existing));
            }
            // Exited: fall through and replace the dead entry.
        }
        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(portable_pty::PtySize {
                cols: options.cols,
                rows: options.rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("openpty failed: {error}"))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut command = portable_pty::CommandBuilder::new(&shell);
        command.arg("-i");
        if let Some(cwd) = cwd {
            command.cwd(cwd);
        }
        command.env_remove("TERM");
        command.env("TERM", "xterm-256color");
        for (key, value) in &options.env {
            command.env(key, value);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("spawn failed: {error}"))?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|error| format!("reader failed: {error}"))?;
        let writer = pair.master.take_writer().map_err(|error| format!("writer failed: {error}"))?;

        let log: LogFn = options.on_log.unwrap_or_else(|| Arc::new(|_line: String| {}));
        let pty = Arc::new(Pty {
            writer: Mutex::new(Some(writer)),
            history: Mutex::new(History::new()),
            io_lock: Mutex::new(()),
            exit: Mutex::new(None),
            exit_cv: Condvar::new(),
            master: Mutex::new(Some(pair.master)),
            log: Arc::clone(&log),
        });

        // Reader thread: chunks land in the history as they arrive (UTF-8 is
        // decoded across chunk boundaries by incremental concatenation).
        {
            let pty = Arc::clone(&pty);
            std::thread::Builder::new()
                .name(format!("pty-reader-{id}"))
                .spawn(move || {
                    let mut buf = [0u8; 8192];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                // Buffer partial UTF-8: push only complete
                                // sequences, keep the tail for the next chunk.
                                let valid = match std::str::from_utf8(&buf[..n]) {
                                    Ok(text) => text.to_string(),
                                    Err(error) => {
                                        let valid_up_to = error.valid_up_to();
                                        // Very defensive: replace invalid bytes
                                        // (the child emitted garbage) but never
                                        // lose the rest of the stream.
                                        let mut text =
                                            String::from_utf8_lossy(&buf[..valid_up_to]).into_owned();
                                        let tail_start = error.error_len().map_or(n, |len| valid_up_to + len);
                                        text.push('\u{fffd}');
                                        let mut carried = text;
                                        if tail_start < n {
                                            carried.push_str(&String::from_utf8_lossy(&buf[tail_start..n]));
                                        }
                                        carried
                                    }
                                };
                                pty.history.lock().unwrap().push(&valid);
                            }
                            Err(error) => {
                                (pty.log)(format!("pty read failed: {error}"));
                                break;
                            }
                        }
                    }
                    // EOF: the child side closed. The EXIT WATCHER alone
                    // records the exit state (EOF is not exit code 0 — the
                    // shell may still be flushing an `exit 7`).
                })
                .map_err(|error| format!("reader thread failed: {error}"))?;
        }

        // Exit watcher: records the real exit status.
        {
            let pty = Arc::clone(&pty);
            std::thread::Builder::new()
                .name(format!("pty-exit-{id}"))
                .spawn(move || {
                    let status = child.wait();
                    let mut exit = pty.exit.lock().unwrap();
                    *exit = match status {
                        Ok(status) if status.success() => Some(ExitState::Exited(0)),
                        Ok(status) => {
                            if status.signal().is_some() {
                                Some(ExitState::Signaled)
                            } else {
                                Some(ExitState::Exited(status.exit_code() as i32))
                            }
                        }
                        Err(_) => Some(ExitState::Signaled),
                    };
                    pty.exit_cv.notify_all();
                    // Release the master so a re-opened reader cannot linger.
                    *pty.master.lock().unwrap() = None;
                    *pty.writer.lock().unwrap() = None;
                })
                .map_err(|error| format!("exit thread failed: {error}"))?;
        }

        let mut map_guard = map;
        let inserted = map_guard.entry(id.to_string()).or_insert_with(|| Arc::clone(&pty)).clone();
        // If the registry already held a live entry (it cannot — the whole
        // open→spawn→insert ran under the lock — but entry() stays the
        // authority), the just-spawned loser must not leak: hang up its
        // master so the child's group gets SIGHUP and the exit watcher ends.
        if !Arc::ptr_eq(&inserted, &pty) {
            *pty.master.lock().unwrap() = None;
            *pty.writer.lock().unwrap() = None;
        }
        Ok(inserted)
    }

    /// An existing live PTY by id.
    pub fn get(&self, id: &str) -> Option<Arc<Pty>> {
        let map = self.inner.lock().unwrap();
        map.get(id).filter(|pty| pty.exit.lock().unwrap().is_none()).cloned()
    }

    /// Close a PTY: kill the child's process group and drop the registry
    /// entry. Further input fails explicitly.
    pub fn close(&self, id: &str) -> bool {
        let pty = {
            let mut map = self.inner.lock().unwrap();
            map.remove(id)
        };
        let Some(pty) = pty else { return false };
        // Closing the master hangs up the slave side (SIGHUP to the group).
        *pty.master.lock().unwrap() = None;
        *pty.writer.lock().unwrap() = None;
        true
    }

    /// All live ids (diagnostics/tests).
    pub fn ids(&self) -> Vec<String> {
        let map = self.inner.lock().unwrap();
        map.iter()
            .filter(|(_, pty)| pty.exit.lock().unwrap().is_none())
            .map(|(id, _)| id.clone())
            .collect()
    }
}



#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn wait_for_output(pty: &Pty, predicate: impl Fn(&str) -> bool, what: &str) -> String {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            // read_since(0) re-reads the whole window each poll (the tests
            // only need "did this text appear yet").
            let text = match pty.read_since(0) {
                ReadOutcome::Reset { text, .. } => text,
                ReadOutcome::Suffix { text, .. } => text,
            };
            if predicate(&text) {
                return text;
            }
            if std::time::Instant::now() > deadline {
                panic!("timed out waiting for {what}; got: {text:?}");
            }
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    #[test]
    fn idempotent_create_returns_the_same_live_pty() {
        let host = PtyHost::new();
        let first = host.create("t1", None, PtyOptions::default()).expect("pty");
        let second = host.create("t1", None, PtyOptions::default()).expect("pty");
        assert!(Arc::ptr_eq(&first, &second), "same id → same instance");
        assert_eq!(host.ids(), vec!["t1".to_string()]);
        host.close("t1");
    }

    #[test]
    fn echo_roundtrip_resize_and_exit_code() {
        let host = PtyHost::new();
        let dir = tempfile::tempdir().expect("tempdir");
        let pty = host
            .create("echo", Some(dir.path()), PtyOptions { cols: 80, rows: 24, ..PtyOptions::default() })
            .expect("pty");
        pty.write_input(b"echo pty-host-marker-$((41+1))\n").expect("input");
        let text = wait_for_output(&pty, |text| text.contains("pty-host-marker-42"), "echo output");
        assert!(text.contains("pty-host-marker-42"), "echoed: {text}");
        pty.resize(120, 40).expect("resize");
        pty.write_input(b"echo after-resize\n").expect("input after resize");
        wait_for_output(&pty, |text| text.contains("after-resize"), "post-resize output");
        pty.write_input(b"exit 7\n").expect("exit input");
        let code = pty.wait_exit(Duration::from_secs(10));
        assert_eq!(code, Some(Some(7)), "the shell's exit code propagates");
        host.close("echo");
    }

    #[test]
    fn unicode_output_survives_chunked_delivery() {
        let host = PtyHost::new();
        let pty = host.create("uni", None, PtyOptions::default()).expect("pty");
        // A CJK + emoji line exercises multi-byte sequences across chunks.
        pty.write_input("printf '中文测试🚀emoji\\n'\n".as_bytes()).expect("input");
        wait_for_output(&pty, |text| text.contains("中文测试🚀emoji"), "unicode output");
        pty.write_input(b"exit 0\n").expect("exit");
        let _ = pty.wait_exit(Duration::from_secs(10));
        host.close("uni");
    }

    #[test]
    fn history_window_and_cursor_semantics() {
        let mut history = History::new();
        history.push("hello ");
        history.push("中文");
        assert_eq!(history.end_cursor(), 6 + 2); // "hello " (6 units) + 中文 (2 units)
        // Suffix read from the middle (after "hello " = 6 units).
        match history.read_since(6) {
            ReadOutcome::Suffix { text, cursor } => {
                assert_eq!(text, "中文");
                assert_eq!(cursor, 8);
            }
            other => panic!("expected suffix, got {other:?}"),
        }
        // Push far beyond the cap: the front falls out of the window.
        let big = "x".repeat(HISTORY_LIMIT_UNITS + 2048);
        history.push(&big);
        assert!(history.dropped_units > 0, "front trimmed");
        // A cursor inside the retained window still gets a suffix.
        let end = history.end_cursor();
        let mid = history.dropped_units + 10;
        match history.read_since(mid) {
            ReadOutcome::Suffix { cursor, .. } => assert_eq!(cursor, end),
            other => panic!("expected suffix, got {other:?}"),
        }
        // A cursor older than the window gets a reset + full replay.
        match history.read_since(0) {
            ReadOutcome::Reset { text, cursor } => {
                assert_eq!(cursor, end);
                assert!(text.len() <= HISTORY_LIMIT_UNITS * 4, "bounded replay");
                assert!(text.starts_with('x'), "replay starts at the window head");
            }
            other => panic!("expected reset, got {other:?}"),
        }
    }

    #[test]
    fn close_then_input_fails_explicitly() {
        let host = PtyHost::new();
        let pty = host.create("close", None, PtyOptions::default()).expect("pty");
        host.close("close");
        assert!(pty.write_input(b"ls\n").is_err(), "input after close fails, never auto-retries");
    }
}

#[test]
fn concurrent_creates_for_one_id_spawn_exactly_one_child() {
    // The race this freezes: create() used to check the map, DROP the lock,
    // spawn, then re-lock to insert — two concurrent calls both spawned and
    // the loser's shell was orphaned (in no registry, unreachable by close).
    let host = std::sync::Arc::new(PtyHost::new());
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let mut handles = Vec::new();
    for _ in 0..8 {
        let host = std::sync::Arc::clone(&host);
        let barrier = std::sync::Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            host.create("race-id", None, PtyOptions::default())
        }));
    }
    let mut first: Option<Arc<Pty>> = None;
    for handle in handles {
        let pty = handle.join().expect("create").expect("pty");
        match &first {
            None => first = Some(Arc::clone(&pty)),
            Some(existing) => {
                assert!(
                    Arc::ptr_eq(existing, &pty),
                    "every concurrent create returns the SAME live PTY"
                );
            }
        }
    }
    // One registry entry, closable.
    assert_eq!(host.ids(), vec!["race-id".to_string()]);
    assert!(host.close("race-id"));
    assert!(host.ids().is_empty());
}
