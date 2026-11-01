//! # pty-host — portable-pty terminals for the Rust desktop host
//!
//! The plan's PTY semantics (§六 PTY 与调度; docs/terminal.md is
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
//! - **exit code**: `wait` reports the child's exit status; cleanup terminates
//!   the shell, with a forced-kill escalation on Unix.
//!
//! The desktop host owns the connection lease and Channel subscriptions.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

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
    /// Host-selected executable and arguments, never supplied by a client.
    pub shell: Option<(std::path::PathBuf, Vec<String>)>,
    /// An authorized directory pinned by the host through spawn.
    #[cfg(unix)]
    pub cwd_handle: Option<std::fs::File>,
    /// Diagnostics (spawn trouble, read errors).
    pub on_log: Option<LogFn>,
}

impl Default for PtyOptions {
    fn default() -> Self {
        Self {
            cols: 80,
            rows: 24,
            env: Vec::new(),
            shell: None,
            #[cfg(unix)]
            cwd_handle: None,
            on_log: None,
        }
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
            let keep_units = HISTORY_LIMIT_UNITS;
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
                if units - dropped > keep_units {
                    dropped += c_units;
                    drop_bytes = char_indices[idx + 1];
                } else {
                    break;
                }
                idx += 1;
            }
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
        if cursor > end {
            return ReadOutcome::Reset { cursor: end, text: self.text.clone() };
        }
        if cursor == end {
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
            if unit_index + c.len_utf16() > offset_units {
                return ReadOutcome::Reset { cursor: end, text: self.text.clone() };
            }
            unit_index += c.len_utf16();
            byte_index = i + c.len_utf8();
        }
        ReadOutcome::Suffix { cursor: end, text: self.text[byte_index..].to_string() }
    }
}

// Preserve incomplete UTF-8 across reads; malformed sequences use replacement characters.
fn decode_utf8(pending: &mut Vec<u8>, eof: bool) -> String {
    let mut output = String::new();
    let mut offset = 0;
    while offset < pending.len() {
        match std::str::from_utf8(&pending[offset..]) {
            Ok(text) => { output.push_str(text); offset = pending.len(); }
            Err(error) => {
                let valid_end = offset + error.valid_up_to();
                output.push_str(std::str::from_utf8(&pending[offset..valid_end]).unwrap());
                offset = valid_end;
                match error.error_len() {
                    Some(len) => { output.push('\u{fffd}'); offset += len; }
                    None if eof => { output.push('\u{fffd}'); offset = pending.len(); }
                    None => break,
                }
            }
        }
    }
    pending.drain(..offset);
    output
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
    cwd: Option<std::path::PathBuf>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    output_closed: std::sync::atomic::AtomicBool,
    #[cfg(unix)]
    pid: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ExitState {
    Exited(i32),
    Signaled,
    Unknown,
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

    fn force_kill(&self) {
        let _child = self.child.lock().unwrap();
        if self.exit.lock().unwrap().is_some() { return; }
        #[cfg(unix)]
        if let Some(pid) = self.pid { unsafe { libc::kill(pid as i32, libc::SIGKILL); } }
        #[cfg(not(unix))]
        let _ = self.killer.lock().unwrap().kill();
    }

    /// Whether the reader has drained all output after EOF.
    pub fn output_closed(&self) -> bool {
        self.output_closed.load(std::sync::atomic::Ordering::Acquire)
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
            Some(ExitState::Unknown) | None => None,
        }
    }

}

impl Drop for PtyHost {
    fn drop(&mut self) {
        self.begin_shutdown();
        let _ = self.shutdown_until(Instant::now() + Duration::from_millis(100));
    }
}

#[derive(Default)]
struct PtyRegistry {
    active: HashMap<String, Arc<Pty>>,
    closing: Vec<(String, Arc<Pty>)>,
    spawning: Vec<PendingSpawn>,
}

struct PendingSpawn {
    id: String,
    _child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
}

struct ShutdownEntry {
    id: String,
    pty: Arc<Pty>,
}

/// Observed leader exits and unresolved identities or registry ranges.
/// `unknown` includes sentinel ranges such as `<registry-busy>`; its length
/// is not a process count. Neither field proves detached descendants exited.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PtyShutdownOutcome {
    pub leader_exited: Vec<String>,
    pub unknown: Vec<String>,
}

/// The registry of running PTYs. Create is idempotent by id.
pub struct PtyHost {
    inner: Arc<Mutex<PtyRegistry>>,
    shutting_down: AtomicBool,
}

impl Default for PtyHost {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyHost {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(PtyRegistry::default())), shutting_down: AtomicBool::new(false) }
    }

    /// Check an existing live identity without launching a replacement.
    pub fn reuse(&self, id: &str, cwd: &std::path::Path) -> Result<bool, String> {
        let map = self.inner.lock().unwrap();
        if self.shutting_down.load(Ordering::Acquire) { return Err("terminal host is shutting down".into()); }
        let Some(existing) = map.active.get(id) else { return Ok(false) };
        if existing.cwd.as_deref() != Some(cwd) {
            return Err("terminal id is already in use for another cwd".to_string());
        }
        let live = matches!(*existing.exit.lock().unwrap(), None | Some(ExitState::Unknown));
        Ok(live)
    }

    /// Create (or return the existing) PTY with this id and cwd.
    /// A live id cannot be reused for a different cwd.
    pub fn create(&self, id: &str, cwd: Option<&std::path::Path>, options: PtyOptions) -> Result<Arc<Pty>, String> {
        self.create_inner(id, cwd, options, || Ok(()))
    }

    fn create_inner(&self, id: &str, cwd: Option<&std::path::Path>, options: PtyOptions, after_spawn: impl FnOnce() -> Result<(), String>) -> Result<Arc<Pty>, String> {
        if self.shutting_down.load(Ordering::Acquire) { return Err("terminal host is shutting down".into()); }
        // The whole open→spawn→insert runs under ONE lock: without it, two
        // concurrent creates for the same id both pass the existence check,
        // both spawn a shell, and the loser's child is orphaned (it is in no
        // registry, so close() can never reach it).
        let mut map = self.inner.lock().unwrap();
        if self.shutting_down.load(Ordering::Acquire) { return Err("terminal host is shutting down".into()); }
        if let Some(existing) = map.active.get(id) {
            if existing.cwd.as_deref() != cwd {
                return Err("terminal id is already in use for another cwd".to_string());
            }
            if matches!(*existing.exit.lock().unwrap(), None | Some(ExitState::Unknown)) {
                return Ok(Arc::clone(existing));
            }
        }
        map.closing.retain(|(_, pty)| !matches!(pty.exit.try_lock().as_deref(), Ok(Some(ExitState::Exited(_) | ExitState::Signaled))));
        if let Some(old) = map.active.remove(id) { map.closing.push((id.to_string(), old)); }
        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(portable_pty::PtySize {
                cols: options.cols,
                rows: options.rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("openpty failed: {error}"))?;

        let (shell, args) = match options.shell {
            Some(shell) => shell,
            None => {
                #[cfg(unix)]
                { (std::env::var_os("SHELL").map(std::path::PathBuf::from).ok_or("no shell configured")?, vec!["-i".to_string()]) }
                #[cfg(windows)]
                { (std::env::var_os("COMSPEC").map(std::path::PathBuf::from).ok_or("no shell configured")?, Vec::new()) }
            },
        };
        #[cfg(unix)]
        if options.cwd_handle.is_some() && !shell.is_absolute() {
            return Err("pinned terminal shell must be an absolute path".to_string());
        }
        let mut command = portable_pty::CommandBuilder::new(shell);
        for arg in args { command.arg(arg); }
        if let Some(cwd) = cwd {
            #[cfg(unix)]
            if options.cwd_handle.is_some() {
                command.env("PWD", cwd);
            } else {
                command.cwd(cwd);
            }
            #[cfg(not(unix))]
            command.cwd(cwd);
        }
        command.env_remove("PI_WEB_PASSWORD");
        command.env_remove("TERM");
        command.env("TERM", "xterm-256color");
        for (key, value) in &options.env {
            command.env(key, value);
        }

        #[cfg(unix)]
        let spawned = if let Some(handle) = options.cwd_handle {
            pair.slave.spawn_command_in_directory(command, handle)
        } else {
            pair.slave.spawn_command(command)
        };
        #[cfg(not(unix))]
        let spawned = pair.slave.spawn_command(command);
        let child = spawned.map_err(|error| format!("spawn failed: {error}"))?;
        drop(pair.slave);
        let killer = child.clone_killer();
        #[cfg(unix)]
        let pid = child.process_id();
        let child = Arc::new(Mutex::new(child));
        map.spawning.push(PendingSpawn { id: id.to_string(), _child: Arc::clone(&child) });
        after_spawn()?;

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
            cwd: cwd.map(std::path::Path::to_path_buf),
            killer: Mutex::new(killer),
            child: Arc::clone(&child),
            output_closed: std::sync::atomic::AtomicBool::new(false),
            #[cfg(unix)]
            pid,
        });

        // Reader thread: chunks land in the history as they arrive (UTF-8 is
        // decoded across chunk boundaries by incremental concatenation).
        {
            let pty = Arc::clone(&pty);
            std::thread::Builder::new()
                .name(format!("pty-reader-{id}"))
                .spawn(move || {
                    let mut buf = [0u8; 8192];
                    let mut pending = Vec::new();
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                pending.extend_from_slice(&buf[..n]);
                                let text = decode_utf8(&mut pending, false);
                                pty.history.lock().unwrap().push(&text);
                            }
                            Err(error) => {
                                (pty.log)(format!("pty read failed: {error}"));
                                break;
                            }
                        }
                    }
                    let text = decode_utf8(&mut pending, true);
                    pty.history.lock().unwrap().push(&text);
                    pty.output_closed.store(true, std::sync::atomic::Ordering::Release);
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
                    loop {
                        // Synchronize reaping with signaling: a reaped PID must
                        // never be signaled after it can be reused by the OS.
                        let mut child = child.lock().unwrap();
                        let state = match child.try_wait() {
                            Ok(None) => { drop(child); std::thread::sleep(Duration::from_millis(10)); continue; }
                            Ok(Some(status)) if status.success() => ExitState::Exited(0),
                            Ok(Some(status)) if status.signal().is_some() => ExitState::Signaled,
                            Ok(Some(status)) => ExitState::Exited(status.exit_code() as i32),
                            Err(error) => { (pty.log)(format!("pty wait failed: {error}")); ExitState::Unknown }
                        };
                        let unknown = state == ExitState::Unknown;
                        *pty.exit.lock().unwrap() = Some(state);
                        pty.exit_cv.notify_all();
                        drop(child);
                        if !unknown {
                            *pty.master.lock().unwrap() = None;
                            *pty.writer.lock().unwrap() = None;
                        }
                        break;
                    }
                })
                .map_err(|error| format!("exit thread failed: {error}"))?;
        }

        let mut map_guard = map;
        let inserted = map_guard.active.entry(id.to_string()).or_insert_with(|| Arc::clone(&pty)).clone();
        // If the registry already held a live entry (it cannot — the whole
        // open→spawn→insert ran under the lock — but entry() stays the
        // authority), the just-spawned loser must not leak: hang up its
        // master so the child's group gets SIGHUP and the exit watcher ends.
        if !Arc::ptr_eq(&inserted, &pty) {
            *pty.master.lock().unwrap() = None;
            *pty.writer.lock().unwrap() = None;
        }
        map_guard.spawning.pop();
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("terminal host is shutting down".into());
        }
        Ok(inserted)
    }

    /// A retained PTY by id, including an exited terminal awaiting expiry.
    pub fn get(&self, id: &str) -> Option<Arc<Pty>> {
        let map = self.inner.lock().unwrap();
        map.active.get(id).cloned()
    }

    /// Close a PTY and drop its registry entry. Further input fails explicitly.
    pub fn close(&self, id: &str) -> bool {
        let pty = {
            let mut map = self.inner.lock().unwrap();
            map.closing.retain(|(_, pty)| !matches!(pty.exit.try_lock().as_deref(), Ok(Some(ExitState::Exited(_) | ExitState::Signaled))));
            let removed = map.active.remove(id);
            if let Some(pty) = &removed { map.closing.push((id.to_string(), Arc::clone(pty))); }
            removed
        };
        let Some(pty) = pty else { return false };
        // The cloned reader holds another master fd; dropping the master alone
        // does not reliably hang up the child. Explicitly terminate it.
        {
            let _child = pty.child.lock().unwrap();
            if pty.exit.lock().unwrap().is_none() { let _ = pty.killer.lock().unwrap().kill(); }
        }
        #[cfg(unix)]
        {
            let pty = Arc::clone(&pty);
            std::thread::spawn(move || {
                if pty.wait_exit(std::time::Duration::from_secs(2)).is_none() { pty.force_kill(); }
            });
        }
        *pty.master.lock().unwrap() = None;
        *pty.writer.lock().unwrap() = None;
        true
    }

    /// Close admission without waiting for an in-flight spawn or registry lock.
    pub fn begin_shutdown(&self) { self.shutting_down.store(true, Ordering::Release); }

    /// Observe actual leader exits until one shared absolute deadline.
    /// Busy locks and failed waits remain tracked as unknown. No signals are
    /// sent: an unbound numeric PID cannot safely identify the spawned child.
    pub fn shutdown_until(&self, deadline: Instant) -> PtyShutdownOutcome {
        self.begin_shutdown();
        let mut outcome = PtyShutdownOutcome::default();
        let registry = match self.inner.try_lock() {
            Ok(registry) => registry,
            Err(_) => { outcome.unknown.push("<registry-busy>".into()); return outcome; }
        };
        let entry = |id: &String, pty: &Arc<Pty>| ShutdownEntry { id: id.clone(), pty: Arc::clone(pty) };
        let mut pending: Vec<ShutdownEntry> = registry.active.iter().map(|(id, pty)| entry(id, pty))
            .chain(registry.closing.iter().map(|(id, pty)| entry(id, pty))).collect();
        // Failed initialization has no exit watcher. Keep the child handle
        // in the registry; no arbitrary Child method is safe on this path.
        outcome.unknown.extend(registry.spawning.iter().map(|spawn| spawn.id.clone()));
        drop(registry);
        loop {
            let mut index = 0;
            while index < pending.len() {
                let item = &pending[index];
                let state = item.pty.exit.try_lock().ok().map(|state| state.clone());
                match state {
                    Some(Some(ExitState::Exited(_) | ExitState::Signaled)) => {
                        outcome.leader_exited.push(item.id.clone()); pending.swap_remove(index);
                    }
                    Some(Some(ExitState::Unknown)) => {
                        outcome.unknown.push(item.id.clone()); pending.swap_remove(index);
                    }
                    _ => index += 1,
                }
            }
            if pending.is_empty() { break; }
            let now = Instant::now();
            if now >= deadline { outcome.unknown.extend(pending.into_iter().map(|entry| entry.id)); break; }
            std::thread::sleep((deadline - now).min(Duration::from_millis(5)));
        }
        outcome
    }

    /// Compatibility wrapper; callers that require evidence use shutdown_until.
    pub fn shutdown(&self) { let _ = self.shutdown_until(Instant::now() + Duration::from_secs(2)); }

    /// All live or unconfirmed ids (diagnostics/tests).
    pub fn ids(&self) -> Vec<String> {
        let map = self.inner.lock().unwrap();
        map.active.iter()
            .filter(|(_, pty)| matches!(*pty.exit.lock().unwrap(), None | Some(ExitState::Unknown)))
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
    fn shutdown_empty_registry_confirms_no_tracked_leaders() {
        let host = PtyHost::new();
        let result = host.shutdown_until(Instant::now());
        assert!(result.leader_exited.is_empty());
        assert!(result.unknown.is_empty());
        assert!(host.create("later", None, PtyOptions::default()).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shutdown_reports_real_leader_exits_and_closes_admission() {
        let host = PtyHost::new();
        let a = host.create("a", None, PtyOptions::default()).unwrap();
        let b = host.create("b", None, PtyOptions::default()).unwrap();
        a.write_input(b"exit 0\n").unwrap(); b.write_input(b"exit 0\n").unwrap();
        let outcome = host.shutdown_until(Instant::now() + Duration::from_secs(2));
        assert!(outcome.unknown.is_empty(), "{outcome:?}");
        assert_eq!(outcome.leader_exited.len(), 2, "{outcome:?}");
        assert!(a.wait_exit(Duration::from_secs(1)).is_some());
        assert!(b.wait_exit(Duration::from_secs(1)).is_some());
        assert!(host.create("later", None, PtyOptions::default()).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shutdown_uses_one_deadline_for_locked_children_and_keeps_tracking() {
        let host = PtyHost::new();
        let a = host.create("a", None, PtyOptions::default()).unwrap();
        let b = host.create("b", None, PtyOptions::default()).unwrap();
        let ga = a.child.lock().unwrap(); let gb = b.child.lock().unwrap();
        let start = Instant::now();
        let outcome = host.shutdown_until(start + Duration::from_millis(60));
        assert!(start.elapsed() < Duration::from_millis(400));
        assert_eq!(outcome.unknown.len(), 2, "{outcome:?}");
        drop(ga); drop(gb);
        a.write_input(b"exit 0\n").unwrap(); b.write_input(b"exit 0\n").unwrap();
        let later = host.shutdown_until(Instant::now() + Duration::from_secs(2));
        assert!(later.unknown.is_empty(), "{later:?}");
        assert_eq!(later.leader_exited.len(), 2);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shutdown_registry_busy_covers_spawn_before_registration() {
        use std::sync::mpsc;
        let host = Arc::new(PtyHost::new());
        let (ready_tx, ready_rx) = mpsc::channel(); let (go_tx, go_rx) = mpsc::channel();
        let worker_host = Arc::clone(&host);
        let worker = std::thread::spawn(move || worker_host.create_inner("race", None, PtyOptions::default(), || {
            ready_tx.send(()).unwrap(); go_rx.recv().unwrap(); Ok(())
        }));
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        host.begin_shutdown();
        let start = Instant::now();
        let outcome = host.shutdown_until(start + Duration::from_millis(60));
        assert_eq!(outcome.unknown, vec!["<registry-busy>"]);
        assert!(start.elapsed() < Duration::from_millis(400));
        go_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        host.get("race").unwrap().write_input(b"exit 0\n").unwrap();
        let later = host.shutdown_until(Instant::now() + Duration::from_secs(2));
        assert!(later.unknown.is_empty(), "{later:?}");
        assert_eq!(later.leader_exited, vec!["race"]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn failed_post_spawn_setup_retains_unknown_child() {
        let host = PtyHost::new();
        assert!(host.create_inner("failed-setup", None, PtyOptions::default(), || Err("fixture failure".into())).is_err());
        let child = Arc::clone(&host.inner.lock().unwrap().spawning[0]._child);
        let outcome = host.shutdown_until(Instant::now() + Duration::from_millis(50));
        assert_eq!(outcome.unknown, vec!["failed-setup"], "{outcome:?}");
        assert!(outcome.leader_exited.is_empty());
        // Explicit cleanup of this test-owned child, not part of shutdown_until.
        let mut child = child.lock().unwrap(); let _ = child.kill(); let _ = child.wait();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unknown_wait_is_not_reported_as_exit_or_replaced() {
        let host = PtyHost::new();
        let pty = host.create("unknown", None, PtyOptions::default()).unwrap();
        *pty.exit.lock().unwrap() = Some(ExitState::Unknown);
        assert_eq!(pty.wait_exit(Duration::ZERO), None);
        assert_eq!(host.ids(), vec!["unknown"]);
        assert!(Arc::ptr_eq(&host.create("unknown", None, PtyOptions::default()).unwrap(), &pty));
        let outcome = host.shutdown_until(Instant::now() + Duration::from_millis(50));
        assert_eq!(outcome.unknown, vec!["unknown"]);
        assert!(outcome.leader_exited.is_empty());
        *pty.exit.lock().unwrap() = None;
        pty.write_input(b"exit 0\n").unwrap();
        let cleanup = host.shutdown_until(Instant::now() + Duration::from_secs(2));
        assert!(cleanup.unknown.is_empty(), "{cleanup:?}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shutdown_does_not_call_slow_unregistered_child_methods() {
        use std::sync::atomic::AtomicUsize;
        #[derive(Debug, Clone)] struct Slow(Arc<AtomicUsize>);
        impl portable_pty::ChildKiller for Slow {
            fn kill(&mut self) -> std::io::Result<()> { self.0.fetch_add(1, Ordering::SeqCst); std::thread::sleep(Duration::from_secs(1)); Ok(()) }
            fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> { Box::new(self.clone()) }
        }
        impl portable_pty::Child for Slow {
            fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> { self.0.fetch_add(1, Ordering::SeqCst); std::thread::sleep(Duration::from_secs(1)); Ok(None) }
            fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> { Err(std::io::Error::other("not used")) }
            fn process_id(&self) -> Option<u32> { None }
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let host = PtyHost::new();
        host.inner.lock().unwrap().spawning.push(PendingSpawn { id: "slow".into(), _child: Arc::new(Mutex::new(Box::new(Slow(Arc::clone(&calls))))) });
        let start = Instant::now();
        let outcome = host.shutdown_until(start + Duration::from_millis(50));
        assert!(start.elapsed() < Duration::from_millis(400));
        assert_eq!(outcome.unknown, vec!["slow"]);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(host.inner.lock().unwrap().spawning.len(), 1);
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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
    fn utf8_decoder_carries_incomplete_sequences_and_recovers_invalid_bytes() {
        let mut pending = Vec::new();
        let mut output = String::new();
        for byte in "中🚀!".as_bytes() {
            pending.push(*byte);
            output.push_str(&decode_utf8(&mut pending, false));
        }
        assert_eq!(output, "中🚀!");
        pending.extend_from_slice(&[0xff, b'x', 0xe4]);
        assert_eq!(decode_utf8(&mut pending, false), "�x");
        assert_eq!(decode_utf8(&mut pending, true), "�");
        assert!(pending.is_empty());
    }

    #[test]
    fn history_respects_surrogate_boundaries_and_byte_offsets() {
        let mut history = History::new();
        history.push("中🚀x");
        assert_eq!(history.read_since(1), ReadOutcome::Suffix { cursor: 4, text: "🚀x".into() });
        assert_eq!(history.read_since(2), ReadOutcome::Reset { cursor: 4, text: "中🚀x".into() });
        let mut history = History::new();
        history.push(&format!("🚀{}", "x".repeat(HISTORY_LIMIT_UNITS - 1)));
        assert!(history.text.encode_utf16().count() <= HISTORY_LIMIT_UNITS);
        assert_eq!(history.dropped_units, 2);
    }

    #[cfg(unix)]
    #[test]
    fn exited_entry_is_replaced_by_new_terminal() {
        let host = PtyHost::new();
        let dir = tempfile::tempdir().unwrap();
        let first = host.create("restart", Some(dir.path()), PtyOptions::default()).unwrap();
        first.write_input(b"exit 0\n").unwrap();
        assert_eq!(first.wait_exit(Duration::from_secs(10)), Some(Some(0)));
        let other = tempfile::tempdir().unwrap();
        assert!(host.create("restart", Some(other.path()), PtyOptions::default()).is_err());
        let second = host.create("restart", Some(dir.path()), PtyOptions::default()).unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(Arc::ptr_eq(&host.get("restart").unwrap(), &second));
        host.close("restart");
    }

    #[test]
    fn same_id_rejects_different_cwd() {
        let host = PtyHost::new();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        host.create("same", Some(a.path()), PtyOptions::default()).unwrap();
        assert!(host.create("same", Some(b.path()), PtyOptions::default()).is_err());
        host.close("same");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn invalid_pinned_cwd_never_falls_back_to_home() {
        let host = PtyHost::new();
        let dir = tempfile::tempdir().unwrap();
        let file = std::fs::File::create(dir.path().join("not-directory")).unwrap();
        let result = host.create("invalid-anchor", Some(dir.path()), PtyOptions { cwd_handle: Some(file), ..PtyOptions::default() });
        assert!(result.is_err());
        assert!(host.get("invalid-anchor").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn conpty_contained_spawn_and_wait() {
        let pair = portable_pty::native_pty_system().openpty(portable_pty::PtySize {
            rows: 24, cols: 80, pixel_width: 0, pixel_height: 0,
        }).unwrap();
        let shell = std::env::var_os("COMSPEC").expect("COMSPEC");
        let mut command = portable_pty::CommandBuilder::new(shell);
        command.args(["/C", "exit", "0"]);
        let mut child = pair.slave.spawn_command_contained(command).unwrap();
        assert!(child.wait().unwrap().success());
    }

    #[cfg(unix)]
    #[test]
    fn bounded_shutdown_leaves_stubborn_shell_unknown() {
        let host = PtyHost::new();
        let dir = tempfile::tempdir().unwrap();
        let pty = host.create("shutdown", Some(dir.path()), PtyOptions::default()).unwrap();
        pty.write_input(b"trap '' HUP; printf 'ready-for-%s\\n' shutdown; while :; do :; done\n").unwrap();
        wait_for_output(&pty, |text| text.contains("ready-for-shutdown\r\n"), "trap installed");
        let result = host.shutdown_until(Instant::now() + Duration::from_millis(50));
        assert_eq!(result.unknown, vec!["shutdown"]);
        assert!(result.leader_exited.is_empty());
        // This test owns the child and uses the ordinary terminal close path.
        host.close("shutdown");
        assert!(pty.wait_exit(Duration::from_secs(5)).is_some());
    }

    #[cfg(unix)]
    #[test]
    fn close_escalates_when_shell_ignores_hangup() {
        let host = PtyHost::new();
        let dir = tempfile::tempdir().unwrap();
        let pty = host.create("stubborn", Some(dir.path()), PtyOptions::default()).unwrap();
        pty.write_input(b"trap '' HUP; printf 'ready-for-%s\\n' close; while :; do :; done\n").unwrap();
        wait_for_output(&pty, |text| text.contains("ready-for-close\r\n"), "trap installed");
        let started = std::time::Instant::now();
        assert!(host.close("stubborn"));
        assert!(pty.wait_exit(Duration::from_secs(5)).is_some(), "uncooperative shell must be killed");
        assert!(started.elapsed() >= Duration::from_millis(1800), "the grace period precedes forced termination");
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
