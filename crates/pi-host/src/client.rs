//! JSONL RPC client for a `pi --mode rpc` child process — the Rust port of
//! `lib/pi-rpc/client.ts` (M0 PoC of the static-frontend Tauri migration).
//!
//! Protocol contract (identical to the TypeScript client):
//! - one complete JSON object per line on stdin/stdout, strict LF framing
//!   (U+2028/U+2029 are data, never separators); `\r` before the LF is
//!   tolerated; blank lines are skipped;
//! - `response` records are correlated to our commands by `id`;
//! - session events (no `id`) fan out to event subscribers;
//! - `extension_ui_request` records are answered via [`PiRpcClient::respond_ui`];
//!   dialog methods (`select`/`confirm`/`input`/`editor`) block in pi until
//!   answered, every other method is fire-and-forget;
//! - startup UI raised before a relay exists is held by
//!   [`PiRpcClient::begin_ui_attach_window`]: replay in arrival order once a
//!   handler registers, cancel (never approve) on deadline/overflow/exit;
//!   one channel (the bridge result envelope) may opt into immediate
//!   delivery through a `bypass` predicate;
//! - diagnostics go to stderr (capped per line), never parsed as protocol;
//! - closing stdin asks pi for an orderly shutdown; `close(grace)` waits and
//!   force-kills the process tree after the grace period.
//!
//! Concurrency: one mutex (`inner`) guards all protocol state, one mutex
//! (`stdin`) guards the pipe. The only allowed nesting is `inner` → `stdin`
//! (cancelling held UI answers the child); nothing takes `inner` while
//! holding `stdin`. The `exiting` flag is duplicated as an atomic so write
//! paths can check it without nesting locks at all.
//!
//! Divergences from the TypeScript client (deliberate, see crate docs):
//! - a held dialog's own `timeout` is a duration counted from arrival, so
//!   expiry is `arrival + timeout` (the TS client compares a duration to the
//!   wall clock, which treats every timed dialog as already expired);
//! - a `command()` whose write lands after shutdown began fails immediately
//!   with [`ErrorKind::Closing`] instead of silently waiting for its timeout.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::error::{ErrorKind, PiRpcError};
use crate::framing::frame_line;

/// Dialog methods pi blocks on; every other extension-UI method is
/// fire-and-forget (an unsolicited response would be a record the child never
/// asked for).
pub const DIALOG_METHODS: [&str; 4] = ["select", "confirm", "input", "editor"];

/// Default bound on requests held by a pre-attach window.
pub const UI_ATTACH_MAX_ENTRIES: usize = 64;

/// Cap on one stderr diagnostic line; longer lines are dropped whole.
const STDERR_LINE_LIMIT: usize = 16_384;

type LogFn = Arc<dyn Fn(String) + Send + Sync>;
type ExitFn = Arc<dyn Fn(Option<i32>) + Send + Sync>;
type BypassFn = Arc<dyn Fn(&Value) -> bool + Send + Sync>;

/// Which environment the child inherits. The plan keeps the user's PATH,
/// proxy and credential environment; only known host-pollution vars are
/// removed — never a near-empty environment.
#[derive(Default, Clone)]
pub struct EnvPolicy {
    inherit: bool,
    set: HashMap<String, String>,
    remove: Vec<String>,
}

impl EnvPolicy {
    /// Inherit the host environment, then apply overrides.
    pub fn inherit() -> Self {
        Self { inherit: true, set: HashMap::new(), remove: Vec::new() }
    }

    /// Start from an empty environment (deterministic tests only).
    pub fn empty() -> Self {
        Self { inherit: false, set: HashMap::new(), remove: Vec::new() }
    }

    pub fn set(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.set.insert(key.into(), value.into());
        self
    }

    pub fn remove_var(mut self, key: impl Into<String>) -> Self {
        self.remove.push(key.into());
        self
    }

    fn apply(&self, command: &mut Command) {
        if !self.inherit {
            command.env_clear();
        }
        for key in &self.remove {
            command.env_remove(key);
        }
        for (key, value) in &self.set {
            command.env(key, value);
        }
    }
}

/// Options for [`PiRpcClient::spawn`].
pub struct SpawnOptions {
    /// Extra CLI arguments after `--mode rpc` (e.g. `--session`, `--no-session`).
    pub args: Vec<String>,
    /// Working directory for the child.
    pub cwd: Option<std::path::PathBuf>,
    /// Environment policy; defaults to inherit + no overrides.
    pub env: EnvPolicy,
    /// stderr lines and lifecycle notes, for logging.
    pub on_log: Option<LogFn>,
    /// Called once when the child exits (orderly or not).
    pub on_exit: Option<ExitFn>,
}

impl Default for SpawnOptions {
    fn default() -> Self {
        Self { args: Vec::new(), cwd: None, env: EnvPolicy::inherit(), on_log: None, on_exit: None }
    }
}

/// One `extension_ui_request` handed to a registered consumer; the consumer
/// answers with [`PiRpcClient::respond_ui`] (dialogs) or not at all
/// (fire-and-forget methods).
#[derive(Debug, Clone)]
pub struct UiRequest {
    pub id: String,
    pub method: String,
    pub record: Value,
}

#[derive(Clone)]
struct UiHandlerEntry {
    tx: std::sync::mpsc::Sender<UiRequest>,
    bypass: Option<BypassFn>,
}

struct PendingEntry {
    tx: std::sync::mpsc::Sender<Result<Value, PiRpcError>>,
    command: String,
}

/// One held `extension_ui_request` with its id, method and expiry.
struct HeldUi {
    record: Value,
    id: String,
    method: String,
    /// When the child's own dialog timeout expires (counted from arrival),
    /// if the child sent one.
    expires_at: Option<Instant>,
}

struct UiWindowState {
    max_entries: usize,
    generation: u64,
}

struct Inner {
    pending: HashMap<String, PendingEntry>,
    event_listeners: Vec<(u64, std::sync::mpsc::Sender<Value>)>,
    next_listener_id: u64,
    ui_handlers: HashMap<String, UiHandlerEntry>,
    ui_window: Option<UiWindowState>,
    ui_buffer: VecDeque<HeldUi>,
    exit_listeners: Vec<std::sync::mpsc::Sender<Option<i32>>>,
    /// Monotonic token of the current pre-attach window (timer validity).
    window_generation: u64,
    exiting: bool,
    exited: bool,
    exit_code: Option<i32>,
    #[cfg(unix)]
    exit_signal: Option<i32>,
    fatal: Option<PiRpcError>,
}

struct Shared {
    inner: Mutex<Inner>,
    stdin: Mutex<Option<ChildStdin>>,
    /// Signaled when `exited` flips (close() waits on it).
    exit_cv: Condvar,
    /// Mirror of `Inner::exiting` for the stdin write paths (checked without
    /// nesting locks; set under `inner`, always alongside the flag there).
    exiting: AtomicBool,
    log: LogFn,
    on_exit: Option<ExitFn>,
    pid: u32,
}

impl Inner {
    fn fail_all(&mut self, error: PiRpcError) {
        for (_, pending) in self.pending.drain() {
            let _ = pending.tx.send(Err(error.clone()));
        }
    }

    /// Drop held UI without answering (the child is gone or shutting down).
    fn discard_ui_buffer(&mut self) {
        self.ui_window = None;
        self.ui_buffer.clear();
    }
}

/// The JSONL RPC client. Cloned through `Arc`; see the module docs for the
/// protocol contract.
pub struct PiRpcClient {
    shared: Arc<Shared>,
}

static COMMAND_COUNTER: AtomicU64 = AtomicU64::new(0);

impl PiRpcClient {
    /// Spawn `executable --mode rpc` with the given options.
    pub fn spawn(executable: &str, options: SpawnOptions) -> Result<Arc<Self>, PiRpcError> {
        let mut command = Command::new(executable);
        command.arg("--mode").arg("rpc");
        command.args(&options.args);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(cwd) = &options.cwd {
            command.current_dir(cwd);
        }
        options.env.apply(&mut command);
        // A GUI app has no console; pi must never flash one on Windows.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        // The child leads its own process group (Unix) so shutdown can reap
        // the whole tree without touching unrelated processes.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }

        let mut child = command
            .spawn()
            .map_err(|error| PiRpcError::spawn(format!("pi process failed to start: {error}")))?;
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let log: LogFn = options.on_log.unwrap_or_else(|| Arc::new(|_line: String| {}));
        let shared = Arc::new(Shared {
            inner: Mutex::new(Inner {
                pending: HashMap::new(),
                event_listeners: Vec::new(),
                next_listener_id: 0,
                ui_handlers: HashMap::new(),
                ui_window: None,
                ui_buffer: VecDeque::new(),
                exit_listeners: Vec::new(),
                window_generation: 0,
                exiting: false,
                exited: false,
                exit_code: None,
                #[cfg(unix)]
                exit_signal: None,
                fatal: None,
            }),
            stdin: Mutex::new(stdin),
            exit_cv: Condvar::new(),
            exiting: AtomicBool::new(false),
            log,
            on_exit: options.on_exit,
            pid,
        });

        if let Some(stdout) = stdout {
            let reader_shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("pi-rpc-stdout".into())
                .spawn(move || reader_loop(stdout, reader_shared))
                .map_err(|error| PiRpcError::spawn(format!("stdout reader thread failed: {error}")))?;
        }
        if let Some(stderr) = stderr {
            let stderr_shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("pi-rpc-stderr".into())
                .spawn(move || stderr_loop(stderr, stderr_shared))
                .map_err(|error| PiRpcError::spawn(format!("stderr reader thread failed: {error}")))?;
        }

        let watcher_shared = Arc::clone(&shared);
        std::thread::Builder::new()
            .name("pi-rpc-exit".into())
            .spawn(move || exit_watcher(child, watcher_shared))
            .map_err(|error| PiRpcError::spawn(format!("exit watcher thread failed: {error}")))?;

        Ok(Arc::new(Self { shared }))
    }

    pub fn pid(&self) -> u32 {
        self.shared.pid
    }

    pub fn has_exited(&self) -> bool {
        self.shared.inner.lock().unwrap().exited
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.shared.inner.lock().unwrap().exit_code
    }

    /// The termination signal (Unix), when the child died by signal.
    #[cfg(unix)]
    pub fn termination_signal(&self) -> Option<i32> {
        self.shared.inner.lock().unwrap().exit_signal
    }

    /// Subscribe to session events (records without a `response` /
    /// `extension_ui_request` type). Dropping the subscription detaches.
    pub fn on_event(&self) -> (std::sync::mpsc::Receiver<Value>, EventSubscription) {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut inner = self.shared.inner.lock().unwrap();
        let id = inner.next_listener_id;
        inner.next_listener_id += 1;
        inner.event_listeners.push((id, tx));
        (rx, EventSubscription { shared: Arc::clone(&self.shared), listener_id: id })
    }

    /// Subscribe to one extension-UI method. `bypass` (optional) claims
    /// immediate delivery for matching records even while the pre-attach
    /// window still holds older ones — for host-internal, non-blocking
    /// channels only (the bridge result envelope); user-visible UI must not
    /// use it. Dropping the subscription detaches the handler.
    pub fn on_ui(
        &self,
        method: &str,
        tx: std::sync::mpsc::Sender<UiRequest>,
        bypass: Option<BypassFn>,
    ) -> UiSubscription {
        {
            let mut inner = self.shared.inner.lock().unwrap();
            inner.ui_handlers.insert(method.to_string(), UiHandlerEntry { tx, bypass });
            flush_buffered_ui(&self.shared, &mut inner);
        }
        UiSubscription { shared: Arc::clone(&self.shared), method: method.to_string() }
    }

    /// How many child-UI requests are waiting for a handler (diagnostics and
    /// tests).
    pub fn pending_ui_requests(&self) -> usize {
        self.shared.inner.lock().unwrap().ui_buffer.len()
    }

    /// Hold child UI raised before the relay exists, for at most `timeout`.
    /// Requests keep their original id and are replayed in arrival order as
    /// their handlers register; whatever the deadline leaves is cancelled,
    /// never approved. Calling it while a window is open replaces it.
    pub fn begin_ui_attach_window(&self, timeout: Duration, max_entries: Option<usize>) {
        let generation = {
            let mut inner = self.shared.inner.lock().unwrap();
            inner.window_generation += 1;
            let generation = inner.window_generation;
            inner.ui_window = Some(UiWindowState {
                max_entries: max_entries.unwrap_or(UI_ATTACH_MAX_ENTRIES).max(1),
                generation,
            });
            generation
        };
        let shared = Arc::clone(&self.shared);
        std::thread::Builder::new()
            .name("pi-rpc-ui-window".into())
            .spawn(move || {
                std::thread::sleep(timeout);
                let mut inner = shared.inner.lock().unwrap();
                if inner.ui_window.as_ref().map(|window| window.generation) == Some(generation) {
                    end_ui_attach_window_locked(&shared, &mut inner);
                }
            })
            .expect("ui window timer thread");
    }

    /// Close the window: replay what has a handler (in arrival order), then
    /// cancel the rest. Idempotent.
    pub fn end_ui_attach_window(&self) {
        let mut inner = self.shared.inner.lock().unwrap();
        end_ui_attach_window_locked(&self.shared, &mut inner);
    }

    /// Subscribe to the child's exit (multi-listener; fires immediately when
    /// the child already exited).
    pub fn on_process_exit(&self) -> std::sync::mpsc::Receiver<Option<i32>> {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut inner = self.shared.inner.lock().unwrap();
        if inner.exited {
            let _ = tx.send(inner.exit_code);
        } else {
            inner.exit_listeners.push(tx);
        }
        rx
    }

    /// Send one command and await its response. `timeout` of `None` waits
    /// forever; a timeout rejects the command but leaves the session running
    /// (the command may still have taken effect — never resend blindly).
    pub fn command(
        &self,
        type_: &str,
        data: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, PiRpcError> {
        let mut data = if data.is_object() { data } else { json!({}) };
        let id = {
            let inner = self.shared.inner.lock().unwrap();
            if inner.exiting || inner.exited || inner.fatal.is_some() {
                return Err(shutdown_error(&inner, "pi process is closing or has exited"));
            }
            // A caller-supplied `data.id` IS the correlation id: pi echoes it
            // on the response, so it must not be replaced by a generated one.
            // A non-string id would lose correlation — reject it here.
            match data.get("id") {
                Some(Value::String(value)) if !value.is_empty() => value.clone(),
                Some(Value::String(_)) | None => generate_command_id(),
                Some(_) => {
                    return Err(PiRpcError::invalid(format!(
                        "command '{}' id must be a string, got {}",
                        type_,
                        kind_of(data.get("id"))
                    )))
                }
            }
        };
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let mut inner = self.shared.inner.lock().unwrap();
            if inner.exiting || inner.exited || inner.fatal.is_some() {
                return Err(shutdown_error(&inner, "pi process is closing or has exited"));
            }
            inner.pending.insert(id.clone(), PendingEntry { tx, command: type_.to_string() });
        }
        data["type"] = json!(type_);
        data["id"] = json!(id);
        if !self.write_record(&data) {
            let mut inner = self.shared.inner.lock().unwrap();
            inner.pending.remove(&id);
            return Err(shutdown_error(&inner, "pi process is closing or has exited"));
        }

        match timeout {
            None => rx
                .recv()
                .map_err(|_| receive_disconnected(&self.shared, type_))
                .and_then(|result| result),
            Some(limit) => match rx.recv_timeout(limit) {
                Ok(result) => result,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // The response may have completed concurrently with the
                    // deadline: only the pending-map owner reports a timeout.
                    let mut inner = self.shared.inner.lock().unwrap();
                    if inner.pending.remove(&id).is_some() {
                        Err(PiRpcError::timeout(format!(
                            "pi RPC '{}' timed out after {} ms",
                            type_,
                            limit.as_millis()
                        )))
                    } else {
                        rx.try_recv()
                            .unwrap_or_else(|_| Err(PiRpcError::timeout(format!(
                                "pi RPC '{}' timed out after {} ms",
                                type_,
                                limit.as_millis()
                            ))))
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    Err(receive_disconnected(&self.shared, type_))
                }
            },
        }
    }

    /// Answer an `extension_ui_request` (dialog methods block in pi until
    /// this arrives). Silently dropped after shutdown began.
    pub fn respond_ui(&self, id: &str, payload: Value) {
        let mut record = if payload.is_object() { payload } else { json!({}) };
        record["type"] = json!("extension_ui_response");
        record["id"] = json!(id);
        self.write_record(&record);
    }

    /// Orderly shutdown: close stdin, wait for the child to exit (up to
    /// `grace`), then force-kill the process tree. Returns the exit code.
    pub fn close(&self, grace: Duration) -> Option<i32> {
        {
            let mut inner = self.shared.inner.lock().unwrap();
            if inner.exited {
                return inner.exit_code;
            }
            inner.exiting = true;
            self.shared.exiting.store(true, Ordering::SeqCst);
            end_ui_attach_window_locked(&self.shared, &mut inner);
        }
        // Closing stdin asks pi for an orderly shutdown.
        *self.shared.stdin.lock().unwrap() = None;

        if !self.wait_exit(Some(grace)) {
            self.kill_tree();
            // The kill is asynchronous; give the watcher a moment to reap it.
            self.wait_exit(Some(Duration::from_secs(5)));
        }
        self.exit_code()
    }

    /// Immediate termination for shutdown deadlines.
    pub fn kill(&self) {
        {
            let mut inner = self.shared.inner.lock().unwrap();
            inner.exiting = true;
            self.shared.exiting.store(true, Ordering::SeqCst);
            end_ui_attach_window_locked(&self.shared, &mut inner);
        }
        self.kill_tree();
    }

    /// Wait (up to `limit`) for the child to exit. Returns whether it exited.
    pub fn wait_exit(&self, limit: Option<Duration>) -> bool {
        let deadline = limit.map(|limit| Instant::now() + limit);
        let mut inner = self.shared.inner.lock().unwrap();
        while !inner.exited {
            match deadline {
                None => {
                    inner = self.shared.exit_cv.wait(inner).unwrap();
                }
                Some(deadline) => {
                    let now = Instant::now();
                    if now >= deadline {
                        return false;
                    }
                    let (guard, _) = self.shared.exit_cv.wait_timeout(inner, deadline - now).unwrap();
                    inner = guard;
                }
            }
        }
        true
    }

    /// Write one record to the child's stdin; false when shutdown began or
    /// the pipe is gone. Never takes the `inner` lock (see module docs).
    fn write_record(&self, record: &Value) -> bool {
        if self.shared.exiting.load(Ordering::SeqCst) {
            return false;
        }
        let mut stdin = self.shared.stdin.lock().unwrap();
        if self.shared.exiting.load(Ordering::SeqCst) {
            return false;
        }
        let Some(stdin) = stdin.as_mut() else { return false };
        let mut line = serde_json::to_string(record).unwrap_or_default();
        line.push('\n');
        match stdin.write_all(line.as_bytes()).and_then(|()| stdin.flush()) {
            Ok(()) => true,
            Err(error) => {
                (self.shared.log)(format!("stdin write failed: {error}"));
                false
            }
        }
    }

    fn kill_tree(&self) {
        kill_process_tree(self.shared.pid);
    }
}

impl std::fmt::Debug for PiRpcClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PiRpcClient").field("pid", &self.shared.pid).finish()
    }
}

/// Subscription that detaches an event listener on drop.
pub struct EventSubscription {
    shared: Arc<Shared>,
    listener_id: u64,
}

impl Drop for EventSubscription {
    fn drop(&mut self) {
        let mut inner = self.shared.inner.lock().unwrap();
        inner.event_listeners.retain(|(id, _)| *id != self.listener_id);
    }
}

/// Subscription that detaches one extension-UI handler on drop.
pub struct UiSubscription {
    shared: Arc<Shared>,
    method: String,
}

impl Drop for UiSubscription {
    fn drop(&mut self) {
        let mut inner = self.shared.inner.lock().unwrap();
        inner.ui_handlers.remove(&self.method);
    }
}

fn kind_of(value: Option<&Value>) -> &'static str {
    match value {
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
        None => "absent",
    }
}

fn generate_command_id() -> String {
    let counter = COMMAND_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    let ticks = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    format!("pi-rust-{counter}-{ticks:x}")
}

fn shutdown_error(inner: &Inner, fallback: &str) -> PiRpcError {
    inner
        .fatal
        .clone()
        .unwrap_or_else(|| PiRpcError::new(ErrorKind::Closing, fallback))
}

fn receive_disconnected(shared: &Shared, command: &str) -> PiRpcError {
    let inner = shared.inner.lock().unwrap();
    inner
        .fatal
        .clone()
        .unwrap_or_else(|| PiRpcError::exit(format!("pi RPC '{command}' lost its transport")))
}

// --- reader / dispatch ------------------------------------------------------

fn reader_loop<R: Read>(stdout: R, shared: Arc<Shared>) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                }
                match frame_line(&buf) {
                    crate::framing::FramedLine::Blank => {}
                    crate::framing::FramedLine::Unparseable(message) => (shared.log)(message),
                    crate::framing::FramedLine::Record(record) => dispatch(&shared, record),
                }
            }
            Err(error) => {
                (shared.log)(format!("stdout read failed: {error}"));
                break;
            }
        }
    }
}

fn dispatch(shared: &Shared, record: Value) {
    let record_type = record.get("type").and_then(Value::as_str);
    if record_type == Some("response") {
        if let Some(id) = record.get("id").and_then(Value::as_str) {
            let mut inner = shared.inner.lock().unwrap();
            if let Some(pending) = inner.pending.remove(id) {
                let success = record.get("success").and_then(Value::as_bool).unwrap_or(false);
                let result = if success {
                    Ok(record.get("data").cloned().unwrap_or(Value::Null))
                } else {
                    let error = record
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("pi RPC '{}' failed", pending.command));
                    Err(PiRpcError::command(error))
                };
                let _ = pending.tx.send(result);
            }
        }
        return;
    }
    if record_type == Some("extension_ui_request") {
        let id = record.get("id").and_then(Value::as_str).map(str::to_string);
        let method = record.get("method").and_then(Value::as_str).map(str::to_string);
        if let (Some(id), Some(method)) = (id, method) {
            let mut inner = shared.inner.lock().unwrap();
            let registration = inner.ui_handlers.get(&method).cloned();
            if let Some(registration) = &registration {
                if let Some(bypass) = &registration.bypass {
                    // A host-internal channel (the bridge result envelope):
                    // deliver at once even while older UI is held. A throwing
                    // predicate must never break dispatch; fall back to the
                    // ordinary ordered path.
                    let delivers_now = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| bypass(&record)))
                        .unwrap_or(false);
                    if delivers_now {
                        deliver_ui_request(shared, &record, &id, &method, registration);
                        return;
                    }
                }
            }
            // Arrival order is absolute: while anything is held, a new request
            // joins the queue even if its handler is already registered, or a
            // later dialog would jump ahead of an earlier one still waiting.
            if !inner.ui_buffer.is_empty() || registration.is_none() {
                if inner.ui_window.is_some() {
                    buffer_ui_request(shared, &mut inner, record, id, method);
                } else {
                    // Dialogs must be answered or pi blocks (until its own
                    // timeout); an unhandled method gets a cancel so it fails
                    // fast upstream.
                    cancel_ui_request(shared, &id, &method);
                }
            } else if let Some(registration) = &registration {
                deliver_ui_request(shared, &record, &id, &method, registration);
            }
        }
        return;
    }
    // Session event: fan out to subscribers; closed channels detach.
    let mut inner = shared.inner.lock().unwrap();
    inner.event_listeners.retain(|(_, tx)| tx.send(record.clone()).is_ok());
}

fn buffer_ui_request(shared: &Shared, inner: &mut Inner, record: Value, id: String, method: String) {
    // The child's own dialog timeout (if any) is authoritative: the replay
    // must not deliver an entry pi already gave up on.
    let expires_at = record
        .get("timeout")
        .and_then(Value::as_f64)
        .filter(|timeout| *timeout > 0.0)
        .map(|timeout| Instant::now() + Duration::from_millis(timeout as u64));
    inner.ui_buffer.push_back(HeldUi { record, id: id.clone(), method: method.clone(), expires_at });
    let max_entries = inner.ui_window.as_ref().map(|window| window.max_entries);
    if let Some(max_entries) = max_entries {
        while inner.ui_buffer.len() > max_entries {
            // Oldest first: overflow must never invert the arrival order the
            // rest of the replay keeps.
            if let Some(evicted) = inner.ui_buffer.pop_front() {
                (shared.log)(format!(
                    "startup UI overflow: cancelled {} {}",
                    evicted.method, evicted.id
                ));
                cancel_ui_request(shared, &evicted.id, &evicted.method);
            }
        }
    }
}

/// Replay held requests in ARRIVAL order, stopping at the first method whose
/// handler is not registered yet: letting a later request through would
/// deliver startup UI out of order once handlers register one at a time.
fn flush_buffered_ui(shared: &Shared, inner: &mut Inner) {
    while let Some(front) = inner.ui_buffer.front() {
        if let Some(expires_at) = front.expires_at {
            if Instant::now() >= expires_at {
                let entry = inner.ui_buffer.pop_front().expect("front entry");
                (shared.log)(format!(
                    "startup UI expired before replay; cancelled {} {}",
                    entry.method, entry.id
                ));
                cancel_ui_request(shared, &entry.id, &entry.method);
                continue;
            }
        }
        let method = front.method.clone();
        if !inner.ui_handlers.contains_key(&method) {
            return;
        }
        let entry = inner.ui_buffer.pop_front().expect("front entry");
        let registration = inner.ui_handlers.get(&entry.method).cloned();
        if let Some(registration) = registration {
            deliver_ui_request(shared, &entry.record, &entry.id, &entry.method, &registration);
        }
    }
}

fn deliver_ui_request(
    shared: &Shared,
    record: &Value,
    id: &str,
    method: &str,
    registration: &UiHandlerEntry,
) {
    let request =
        UiRequest { id: id.to_string(), method: method.to_string(), record: record.clone() };
    if registration.tx.send(request).is_err() {
        // The consumer is gone: answer dialogs so the child does not block.
        cancel_ui_request(shared, id, method);
    }
}

/// Cancel one UI request: dialogs get `{cancelled: true}`, fire-and-forget
/// methods get nothing (an unsolicited response would be a record the child
/// never asked for). Called with `inner` held; takes the `stdin` lock below
/// it (the allowed nesting — see module docs).
fn cancel_ui_request(shared: &Shared, id: &str, method: &str) {
    if !DIALOG_METHODS.contains(&method) {
        return;
    }
    if shared.exiting.load(Ordering::SeqCst) {
        return;
    }
    let mut record = json!({ "cancelled": true });
    record["type"] = json!("extension_ui_response");
    record["id"] = json!(id);
    let mut stdin = shared.stdin.lock().unwrap();
    if shared.exiting.load(Ordering::SeqCst) {
        return;
    }
    if let Some(stdin) = stdin.as_mut() {
        let mut line = serde_json::to_string(&record).unwrap_or_default();
        line.push('\n');
        let _ = stdin.write_all(line.as_bytes()).and_then(|()| stdin.flush());
    }
}

fn end_ui_attach_window_locked(shared: &Shared, inner: &mut Inner) {
    if inner.ui_window.take().is_none() {
        return;
    }
    flush_buffered_ui(shared, inner);
    // No handler ever arrived for these: a dialog is cancelled (pi resolves
    // it as undefined/false — never as the approval we would otherwise
    // invent).
    for entry in inner.ui_buffer.drain(..) {
        (shared.log)(format!(
            "startup UI window closed before its deadline; cancelled {} {}",
            entry.method, entry.id
        ));
        cancel_ui_request(shared, &entry.id, &entry.method);
    }
}

// --- stderr ------------------------------------------------------------------

fn stderr_loop<R: Read>(stderr: R, shared: Arc<Shared>) {
    let mut reader = BufReader::new(stderr);
    let mut buffer: Vec<u8> = Vec::new();
    let mut dropping = false;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                let had_newline = buf.last() == Some(&b'\n');
                if had_newline {
                    buf.pop();
                }
                if !dropping {
                    if buffer.len() + buf.len() > STDERR_LINE_LIMIT {
                        buffer.clear();
                        dropping = true;
                    } else {
                        buffer.extend_from_slice(&buf);
                    }
                }
                if had_newline {
                    if dropping {
                        (shared.log)("[stderr line omitted: exceeds diagnostic limit]".to_string());
                    } else if !buffer.is_empty() {
                        let mut line = String::from_utf8_lossy(&buffer).into_owned();
                        if line.ends_with('\r') {
                            line.pop();
                        }
                        (shared.log)(line);
                    }
                    buffer.clear();
                    dropping = false;
                }
            }
            Err(error) => {
                (shared.log)(format!("stderr read failed: {error}"));
                break;
            }
        }
    }
    if !buffer.is_empty() && !dropping {
        (shared.log)(String::from_utf8_lossy(&buffer).into_owned());
    }
}

// --- exit watcher -------------------------------------------------------------

fn exit_watcher(mut child: std::process::Child, shared: Arc<Shared>) {
    let status = child.wait();
    let code = status.as_ref().ok().and_then(|status| status.code());
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.as_ref().ok().and_then(|status| status.signal())
    };
    let (code, message) = {
        let mut inner = shared.inner.lock().unwrap();
        let was_exiting = inner.exiting;
        let code_repr = code.map(|code| code.to_string()).unwrap_or_else(|| {
            #[cfg(unix)]
            {
                signal.map(|signal| format!("signal {signal}")).unwrap_or_else(|| "?".to_string())
            }
            #[cfg(not(unix))]
            {
                "?".to_string()
            }
        });
        let message = format!(
            "pi process exited {} ({code_repr})",
            if was_exiting { "during shutdown" } else { "unexpectedly" }
        );
        inner.exited = true;
        inner.exit_code = code;
        #[cfg(unix)]
        {
            inner.exit_signal = signal;
        }
        // No one is left to answer: drop the held UI without a response (the
        // child is gone, and writing a cancel to its dead pipe only risks
        // EPIPE).
        inner.discard_ui_buffer();
        let error = PiRpcError::exit(message.clone());
        if inner.fatal.is_none() {
            inner.fatal = Some(error.clone());
        }
        inner.fail_all(error);
        inner.exit_listeners.drain(..).for_each(|tx| {
            let _ = tx.send(code);
        });
        shared.exit_cv.notify_all();
        (code, message)
    };
    (shared.log)(message);
    if let Some(on_exit) = &shared.on_exit {
        on_exit(code);
    }
}

/// Kill the child's whole process tree. Unix: the child leads its own process
/// group (set at spawn), so killpg reaps descendants without touching
/// unrelated processes. Windows: `taskkill /T /F` on the pid.
fn kill_process_tree(pid: u32) {
    #[cfg(unix)]
    {
        let pid = pid as i32;
        let killed = unsafe { libc::killpg(pid, libc::SIGKILL) } == 0;
        if !killed {
            // Not a group leader (or already gone): fall back to the pid.
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .status();
    }
}
