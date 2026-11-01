//! The static-UI acceptance harness (test-only; `--features harness`).
//!
//! Purpose: drive the REAL static frontend bundle (desktop/frontend-static)
//! in a real browser against the REAL host code (`pi_ipc`'s command
//! functions) and REAL pi CLI children — without the Tauri WebView layer.
//! What it replaces is ONLY Tauri's own invoke/Channel plumbing:
//!
//! - `POST /__harness__/invoke {cmd, args}` → the real `pi_ipc` dispatch
//!   (`dispatch_envelope_gated` — the SAME bounded gate + blocking pool the
//!   product's async `pi_ipc` command runs, never a harness-invented thread
//!   scheme) or the real `pi_ipc_subscribe_events` /
//!   `pi_ipc_subscribe_running` commands with a `Channel` built from
//!   `Channel::new` (exactly the construction pi_ipc's own unit tests use);
//! - `GET /__harness__/events` (SSE) → channel frames `{cb, payload}` where
//!   `payload` is the official `{message, index}` envelope
//!   `@tauri-apps/api/core`'s Channel class expects;
//! - `POST /__harness__/shutdown` → an orderly stop (every session child,
//!   management instance and PTY is shut down) before process exit, so no
//!   pi child is orphaned when the driver reaps the harness;
//! - `GET /*` → the static bundle from the directory the driver built.
//!
//! The bridge endpoints (invoke/events/shutdown) require the random token
//! from `STATIC_UI_HARNESS_TOKEN` (header `x-harness-token`; `?token=` for
//! the SSE stream, which cannot attach headers) — without it any website
//! open in the user's browser could drive the real pi host over a simple
//! cross-site POST (the response stays unreadable, the side effects do
//! not). Static GETs stay tokenless: subresource loads cannot attach
//! headers, the bundle holds no secrets, and the listener is loopback-only
//! — the same posture as a dev server.
//!
//! The browser side is `scripts/migration/static-ui-harness-polyfill.js`
//! (injected via playwright addInitScript): a `__TAURI_INTERNALS__` whose
//! `invoke`/`transformCallback`/`unregisterCallback` are the only three
//! entry points `@tauri-apps/api/core` touches.
//!
//! Run by `scripts/migration/static-ui-acceptance.mjs`; never packaged
//! (`required-features` keeps it out of normal builds).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::test::MockRuntime;
use tauri::App;
use tauri::Manager;

use pi_agent_desktop_lib::pi_ipc::{
    dispatch_envelope_gated, pi_ipc_subscribe_events, pi_ipc_subscribe_running, pi_ipc_subscribe_terminal, pi_ipc_subscribe_scheduled, IpcHostState,
};

/// One call the host thread (which owns the `App` and therefore the
/// `State<'_, Arc<IpcHostState>>` the real subscribe commands take) executes
/// for an HTTP thread, answering on the reply channel. Pi requests do NOT
/// come through here: they run the product's own gated dispatch
/// (`dispatch_envelope_gated`, the same gate + blocking pool + caps the
/// async `pi_ipc` command runs) directly from the connection thread — the
/// harness must not serialize what the product runs concurrently, and must
/// not grow a dispatch path the product lacks either.
enum HostCall {
    SubscribeEvents { session: String, cb: u32 },
    SubscribeRunning { cb: u32 },
    SubscribeTerminal { id: String, cursor: u64, cb: u32 },
    SubscribeScheduled { cb: u32 },
    /// Orderly teardown of everything the host owns children-wise (sessions,
    /// management instances, PTYs). The connection thread exits the process
    /// once the reply is flushed.
    Shutdown,
}

/// One browser-side Channel callback: frames are wrapped with the official
/// index envelope and pushed to every live SSE stream (one page = one).
#[derive(Default)]
struct Bridge {
    sse_senders: Mutex<Vec<(u64, std::sync::mpsc::Sender<String>)>>,
    next_sse_id: std::sync::atomic::AtomicU64,
    /// The event-plugin stand-in: `(event id, event name, handler callback
    /// id)`. `plugin:event|listen` registers; `plugin:event|emit` delivers
    /// the official Event envelope to each handler's transformCallback id.
    event_handlers: Mutex<Vec<(u64, String, u32)>>,
    next_event_id: std::sync::atomic::AtomicU64,
}

impl Bridge {
    /// A Channel<Value> whose sends arrive in the browser at callback `cb`
    /// (the JS side registered `window._<cb>` via transformCallback).
    fn channel(self: &Arc<Self>, cb: u32) -> Channel<Value> {
        // A reloaded page can reuse callback ids, but each Channel has its
        // own index sequence.
        let index = std::sync::atomic::AtomicU64::new(0);
        let bridge = Arc::clone(self);
        Channel::new(move |body: InvokeResponseBody| {
            let InvokeResponseBody::Json(text) = body else {
                // The host only sends JSON channel frames today; anything
                // else must not silently vanish.
                eprintln!("[harness] non-JSON channel body for callback {cb} ignored");
                return Ok(());
            };
            let message: Value = match serde_json::from_str(&text) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("[harness] channel frame is not JSON for callback {cb}: {error}");
                    return Ok(());
                }
            };
            // The index is the Channel's ORDERING contract: the JS Channel
            // class starts at nextMessageIndex 0 and queues anything newer,
            // so the FIRST frame must be index 0 — exactly the real runtime's
            // counter (tauri's JavaScriptChannelId starts an AtomicUsize at 0
            // and fetch_adds per send). Starting at 1 wedges every frame in
            // pendingMessages forever (no snapshot, no `connected`).
            let index = index.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let frame = json!({
                "harness": "callback",
                "cb": cb,
                "payload": { "message": message, "index": index },
            });
            let line = serde_json::to_string(&frame).expect("the SSE frame serializes");
            let mut senders = bridge.sse_senders.lock().unwrap();
            senders.retain(|(_, sender)| sender.send(line.clone()).is_ok());
            Ok(())
        })
    }

    /// Register one SSE connection; returns its id (for explicit removal
    /// when the stream loop ends).
    fn register_sse(&self, sender: std::sync::mpsc::Sender<String>) -> u64 {
        let id = self.next_sse_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.sse_senders.lock().unwrap().push((id, sender));
        id
    }

    fn unregister_sse(&self, id: u64) {
        self.sse_senders.lock().unwrap().retain(|(entry, _)| *entry != id);
    }

    /// Push one raw payload to a browser-side plain callback (NOT a Channel:
    /// no index envelope — the callback receives the payload as-is, exactly
    /// how Tauri's event plugin delivers).
    fn push_to_callback(&self, cb: u32, payload: Value) {
        let frame = json!({
            "harness": "callback",
            "cb": cb,
            "payload": payload,
        });
        let line = serde_json::to_string(&frame).expect("the SSE frame serializes");
        let mut senders = self.sse_senders.lock().unwrap();
        senders.retain(|(_, sender)| sender.send(line.clone()).is_ok());
    }

    /// `plugin:event|listen`: returns the event id the API expects.
    fn event_listen(&self, event: &str, handler_cb: u32) -> u64 {
        let id = self.next_event_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        self.event_handlers
            .lock()
            .unwrap()
            .push((id, event.to_string(), handler_cb));
        id
    }

    /// `plugin:event|unlisten` (by the id `event_listen` returned).
    fn event_unlisten(&self, event_id: u64) {
        self.event_handlers.lock().unwrap().retain(|(id, _, _)| *id != event_id);
    }

    /// `plugin:event|emit`: deliver the official Event envelope
    /// `{event, id, payload}` to every live handler for the event name.
    fn event_emit(&self, event: &str, payload: Value) {
        let handlers: Vec<(u64, u32)> = self
            .event_handlers
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, name, _)| name == event)
            .map(|(id, _, cb)| (*id, *cb))
            .collect();
        for (id, cb) in handlers {
            self.push_to_callback(
                cb,
                json!({ "event": event, "id": id, "payload": payload }),
            );
        }
    }
}

/// Parse the JS Channel serialization ("__CHANNEL__:<callbackId>").
fn channel_ref(value: &Value) -> Option<u32> {
    let text = value.as_str()?;
    let rest = text.strip_prefix("__CHANNEL__:")?;
    rest.parse().ok()
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
    /// The `x-harness-token` header (the bridge endpoints' CSRF check).
    token_header: Option<String>,
    range_header: Option<String>,
}

/// Request-line/header bound: a peer must not be able to grow memory with
/// an unbounded line (this is a loopback test server, not a hardened one —
/// but the bound is free).
const MAX_LINE_BYTES: usize = 64 * 1024;
/// Body bound: the largest legitimate payload is an invoke carrying
/// attachments (base64 images), far below this.
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Minimal HTTP/1.1: request line + headers + Content-Length body. The
/// reader lives per CONNECTION (a fresh reader per request would lose
/// buffered bytes of a keep-alive follow-up).
fn read_request(reader: &mut BufReader<TcpStream>) -> std::io::Result<Option<Request>> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None); // closed
    }
    if line.len() > MAX_LINE_BYTES {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "request line too long"));
    }
    let mut parts = line.trim_end().splitn(3, ' ');
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();
    let mut content_length = 0usize;
    let mut token_header: Option<String> = None;
    let mut range_header: Option<String> = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            return Ok(None);
        }
        if header.len() > MAX_LINE_BYTES {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "header line too long"));
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().map_err(|_| {
                    std::io::Error::new(std::io::ErrorKind::InvalidData, "bad content-length")
                })?;
            } else if name.trim().eq_ignore_ascii_case("x-harness-token") {
                token_header = Some(value.trim().to_string());
            } else if name.trim().eq_ignore_ascii_case("range") {
                range_header = Some(value.trim().to_string());
            }
        }
    }
    if content_length > MAX_BODY_BYTES {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "body too large"));
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }
    Ok(Some(Request { method, path, body, token_header, range_header }))
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn main() {
    let mut static_dir: Option<PathBuf> = None;
    let mut scheduler_agent_dir: Option<PathBuf> = None;
    let mut isolated_lifecycle_agent_dir: Option<PathBuf> = None;
    let mut port: u16 = 0;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--static-dir" => static_dir = args.next().map(PathBuf::from),
            "--port" => port = args.next().and_then(|value| value.parse().ok()).unwrap_or(0),
            "--scheduler-agent-dir" => scheduler_agent_dir = args.next().map(PathBuf::from),
            "--isolated-lifecycle-agent-dir" => isolated_lifecycle_agent_dir = args.next().map(PathBuf::from),
            other => {
                eprintln!("[harness] unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }
    let static_dir = static_dir.unwrap_or_else(|| {
        eprintln!("[harness] --static-dir is required (desktop/frontend-static)");
        std::process::exit(2);
    });
    if !static_dir.is_dir() {
        eprintln!(
            "[harness] the static bundle is missing at {} (run static-frontend's npm run build)",
            static_dir.display()
        );
        std::process::exit(2);
    }
    // The bridge token: without it any website open in the user's browser
    // could drive the real pi host with a cross-site POST (simple requests
    // are sent without preflight; only the response stays unreadable). Env
    // (not argv) so it is not world-readable in /proc/<pid>/cmdline.
    let token = std::env::var("STATIC_UI_HARNESS_TOKEN").unwrap_or_else(|_| {
        eprintln!(
            "[harness] STATIC_UI_HARNESS_TOKEN is required — the driver generates one per run"
        );
        std::process::exit(2);
    });
    if token.len() < 32 {
        eprintln!("[harness] STATIC_UI_HARNESS_TOKEN must be at least 32 chars (random)");
        std::process::exit(2);
    }
    // If the driver dies without reaping (SIGKILL, CI timeout), the harness
    // must not keep listening forever — a previous round leaked hours-old
    // harness processes exactly this way. Linux's parent-death signal ends
    // this process with its driver; the pi children then see their stdin
    // pipes close (EOF) and exit.
    #[cfg(target_os = "linux")]
    unsafe {
        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
            eprintln!("[harness] PR_SET_PDEATHSIG failed (continuing without it)");
        }
        // The parent may have died between spawn and prctl — check to avoid
        // an orphan that missed its death signal.
        if libc::getppid() == 1 {
            eprintln!("[harness] parent already gone at startup; exiting");
            std::process::exit(2);
        }
    }

    // The host thread owns the mock-runtime app (`App` is Send but not
    // Sync) — only the fast subscribe REGISTRATIONS and shutdown funnel
    // through it, mirroring the product where those are quick sync commands
    // on the UI thread. `State<'_, Arc<IpcHostState>>` only exists there.
    // Envelope requests share the state Arc directly and dispatch through
    // the product's gated entry from their connection threads.
    if isolated_lifecycle_agent_dir.is_some() && scheduler_agent_dir.is_some() {
        panic!("isolated lifecycle does not start or own the scheduler");
    }
    let isolated_host = isolated_lifecycle_agent_dir.map(|agent| {
        let configured = std::env::var_os("PI_CODING_AGENT_DIR").map(PathBuf::from)
            .and_then(|path| path.canonicalize().ok()).expect("isolated agent environment is required");
        assert_eq!(agent.canonicalize().expect("agent exists"), configured, "agent environment mismatch");
        pi_agent_desktop_lib::static_host::IsolatedStaticHost::init(&agent).expect("isolated lifecycle init")
    });
    let host_state = isolated_host.as_ref().map(|host| Arc::clone(&host.state))
        .unwrap_or_else(|| Arc::new(IpcHostState::new()));
    if let Some(root) = std::env::var_os("STATIC_UI_HARNESS_FIXTURE_ROOT") {
        let root = PathBuf::from(root).canonicalize().expect("fixture root exists");
        let temp = std::env::temp_dir().canonicalize().expect("temporary directory resolves");
        if !root.starts_with(&temp) || root == temp { panic!("fixture root must be an isolated temporary directory"); }
        host_state.propose_path(&root).expect("fixture root must be authorized");
    }
    if let Some(agent) = scheduler_agent_dir {
        let isolated = std::env::var_os("PI_CODING_AGENT_DIR").map(PathBuf::from).and_then(|path| path.canonicalize().ok());
        let agent = agent.canonicalize().expect("scheduler fixture agent dir must exist");
        let temp = std::env::temp_dir().canonicalize().expect("temporary directory resolves");
        if isolated.as_ref() != Some(&agent) || !agent.starts_with(&temp) || agent == temp {
            eprintln!("[harness] scheduler agent dir must be an explicit isolated temporary PI_CODING_AGENT_DIR");
            std::process::exit(2);
        }
        *host_state.task_agent_dir.lock().unwrap() = Some(agent);
        host_state.start_scheduler().expect("scheduler starts");
    }
    let host_state_for_host = Arc::clone(&host_state);
    let host_state_for_http = Arc::clone(&host_state);
    let (host_tx, host_rx) = std::sync::mpsc::channel::<(HostCall, std::sync::mpsc::Sender<Value>)>();
    let bridge = Arc::new(Bridge::default());
    let bridge_for_host = Arc::clone(&bridge);
    thread::spawn(move || {
        let app: App<MockRuntime> = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("the mock app builds");
        app.manage(host_state_for_host);
        for (call, reply) in host_rx {
            let value = match call {
                HostCall::SubscribeEvents { session, cb } => pi_ipc_subscribe_events(
                    app.state::<Arc<IpcHostState>>(),
                    session,
                    bridge_for_host.channel(cb),
                ),
                HostCall::SubscribeRunning { cb } => {
                    pi_ipc_subscribe_running(app.state::<Arc<IpcHostState>>(), bridge_for_host.channel(cb))
                }
                HostCall::SubscribeTerminal { id, cursor, cb } => {
                    pi_ipc_subscribe_terminal(app.state::<Arc<IpcHostState>>(), id, cursor, bridge_for_host.channel(cb))
                }
                HostCall::SubscribeScheduled { cb } => {
                    pi_ipc_subscribe_scheduled(app.state::<Arc<IpcHostState>>(), bridge_for_host.channel(cb))
                }
                HostCall::Shutdown if isolated_host.is_some() => {
                    let host = isolated_host.as_ref().unwrap();
                    let result = host.shutdown_until(std::time::Instant::now() + std::time::Duration::from_secs(5));
                    let report = match host.tracked() {
                        Ok(report) => report,
                        Err(error) => {
                            let _ = reply.send(json!({ "harness": "shutdown", "ok": false,
                                "failures": result.err().unwrap_or_default().iter().map(|f| format!("{}: {}", f.name, f.error)).collect::<Vec<_>>(),
                                "reportError": error, "sessionReportStatus": "unknown",
                                "sessionExited": null, "sessionUnknown": null, "sessionDiagnostics": null }));
                            continue;
                        }
                    };
                    let session_fields = pi_agent_desktop_lib::static_host::session_report_fields(report.sessions.as_ref());
                    json!({
                        "harness": "shutdown", "ok": result.is_ok(),
                        "failures": result.err().unwrap_or_default().iter().map(|f| format!("{}: {}", f.name, f.error)).collect::<Vec<_>>(),
                        "scheduler": report.scheduler.as_ref(),
                        "schedulerMayRepeatSessionDiagnostics": true,
                        "sessionReportStatus": session_fields["sessionReportStatus"],
                        "sessionExited": session_fields["sessionExited"],
                        "sessionUnknown": session_fields["sessionUnknown"],
                        "sessionDiagnostics": session_fields["sessionDiagnostics"],
                        "writerCompleted": report.session_writers.as_ref().map(|r| &r.exited),
                        "writerUnknown": report.session_writers.as_ref().map(|r| &r.unknown),
                        "managementExited": report.management.as_ref().map(|r| &r.exited),
                        "managementUnknown": report.management.as_ref().map(|r| &r.unknown),
                        "uncovered": ["unregistered writers", "scheduler prompt correlation and lease recovery", "terminals", "detached descendants", "cross-restart writer durability"]
                    })
                }
                HostCall::Shutdown => {
                    // Orderly teardown, the same paths the product uses per
                    // child (stdin EOF + grace kill of the child's process
                    // group), so no pi process is orphaned by this exit.
                    let state = app.state::<Arc<IpcHostState>>();
                    if let Err(error) = state.shutdown_scheduler() { eprintln!("[harness] scheduler shutdown: {error}"); }
                    for id in state.registry.ids() {
                        let _ = state.registry.remove(&id, std::time::Duration::from_secs(5));
                    }
                    state.management.shutdown_all(std::time::Duration::from_secs(5));
                    for id in state.terminals.ids() {
                        state.terminals.close(&id);
                    }
                    json!({ "harness": "shutdown" })
                }
            };
            let _ = reply.send(value);
        }
    });

    let listener = TcpListener::bind(("127.0.0.1", port)).expect("the harness binds");
    let port = listener.local_addr().expect("a local address").port();
    // The driver reads this line to learn the port (port 0 = OS-assigned).
    println!("{{\"harness\":\"ready\",\"port\":{port}}}");
    std::io::stdout().flush().ok();

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let static_dir = static_dir.clone();
        let host_tx = host_tx.clone();
        let host_state = Arc::clone(&host_state_for_http);
        let bridge = Arc::clone(&bridge);
        let token = token.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stream.try_clone().expect("the stream clones"));
            let mut stream = stream;
            loop {
                let Ok(Some(request)) = read_request(&mut reader) else { return };
                // The bridge endpoints demand the token; the static bundle
                // does not (subresource loads cannot attach headers).
                let path_only = request.path.split('?').next().unwrap_or("").to_string();
                let header_ok = request.token_header.as_deref() == Some(token.as_str());
                let query_ok = request
                    .path
                    .split('?')
                    .nth(1)
                    .and_then(|query| query.split('&').find(|pair| pair.starts_with("token=")))
                    .map(|pair| &pair["token=".len()..])
                    == Some(token.as_str());
                match (request.method.as_str(), path_only.as_str()) {
                    ("POST", "/__harness__/invoke") => {
                        if !header_ok {
                            eprintln!("[harness] invoke refused: missing or wrong token");
                            if write_response(&mut stream, "403 Forbidden", "application/json", b"{\"error\":\"token\"}").is_err() {
                                return;
                            }
                            continue;
                        }
                        let body = handle_invoke(&bridge, &host_tx, &host_state, &request.body);
                        let text = serde_json::to_string(&body).expect("the invoke reply serializes");
                        if write_response(&mut stream, "200 OK", "application/json", text.as_bytes()).is_err() {
                            return;
                        }
                    }
                    ("POST", "/__harness__/shutdown") => {
                        if !header_ok {
                            eprintln!("[harness] shutdown refused: missing or wrong token");
                            let _ = write_response(&mut stream, "403 Forbidden", "application/json", b"{\"error\":\"token\"}");
                            return;
                        }
                        let (reply_tx, reply_rx) = std::sync::mpsc::channel::<Value>();
                        if host_tx.send((HostCall::Shutdown, reply_tx)).is_err() {
                            let _ = write_response(&mut stream, "500 Internal Server Error", "application/json", b"{\"error\":\"host unavailable\"}");
                            return;
                        }
                        let result = match reply_rx.recv_timeout(std::time::Duration::from_secs(60)) {
                            Ok(result) => result,
                            Err(_) => { let _ = write_response(&mut stream, "500 Internal Server Error", "application/json", b"{\"error\":\"shutdown timeout\"}"); return; }
                        };
                        if result.get("ok") == Some(&Value::Bool(false)) {
                            let body = serde_json::to_vec(&result).unwrap();
                            let _ = write_response(&mut stream, "500 Internal Server Error", "application/json", &body);
                            return;
                        }
                        // The isolated lifecycle reports its limited coverage explicitly.
                        let body = if result.get("ok").is_some() { serde_json::to_vec(&result).unwrap() } else { b"{\"harness\":\"stopping\"}".to_vec() };
                        let _ = write_response(&mut stream, "200 OK", "application/json", &body);
                        eprintln!("[harness] shutdown complete; exiting");
                        std::process::exit(0);
                    }
                    ("GET", "/__harness__/events") => {
                        if !query_ok {
                            eprintln!("[harness] events refused: missing or wrong token");
                            let _ = write_response(
                                &mut stream,
                                "403 Forbidden",
                                "application/json",
                                b"{\"error\":\"token\"}",
                            );
                            return;
                        }
                        // SSE: register a sender, stream frames until the
                        // connection drops (a failed write reaps it).
                        let (sender, receiver) = std::sync::mpsc::channel::<String>();
                        let sse_id = bridge.register_sse(sender);
                        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
                        if stream.write_all(head.as_bytes()).is_err() || stream.flush().is_err() {
                            bridge.unregister_sse(sse_id);
                            return;
                        }
                        while let Ok(frame) = receiver.recv() {
                            let chunk = format!("data: {frame}\n\n");
                            if stream.write_all(chunk.as_bytes()).is_err() || stream.flush().is_err() {
                                break;
                            }
                        }
                        bridge.unregister_sse(sse_id);
                        return;
                    }
                    ("GET", path) if path.starts_with("/__harness__/resource/") => {
                        let resource_path = request.path.strip_prefix("/__harness__/resource").unwrap();
                        let mut builder = tauri::http::Request::builder().uri(resource_path);
                        if let Some(range) = &request.range_header { builder = builder.header("range", range); }
                        let Ok(resource_request) = builder.body(Vec::new()) else { return };
                        let response = pi_agent_desktop_lib::resource_handler::respond(&host_state.resources, resource_request);
                        let mut head = format!("HTTP/1.1 {}\r\n", response.status());
                        for (name, value) in response.headers() {
                            if let Ok(value) = value.to_str() { head.push_str(&format!("{name}: {value}\r\n")); }
                        }
                        if !response.headers().contains_key("content-length") { head.push_str(&format!("Content-Length: {}\r\n", response.body().len())); }
                        head.push_str("Connection: keep-alive\r\n\r\n");
                        if stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(response.body())).and_then(|_| stream.flush()).is_err() { return; }
                    }
                    ("GET", _) => {
                        if !serve_static(&mut stream, &static_dir, &request.path) {
                            return;
                        }
                    }
                    (method, path) => {
                        let body = format!("{{\"message\":\"harness: {method} {path} is not served\"}}");
                        if write_response(&mut stream, "404 Not Found", "application/json", body.as_bytes()).is_err() {
                            return;
                        }
                    }
                }
            }
        });
    }
}

/// Serve one static file (path traversal refused). Keep-alive friendly.
fn serve_static(stream: &mut TcpStream, root: &Path, raw_path: &str) -> bool {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let clean = raw_path.split('?').next().unwrap_or("/");
    let relative = clean.trim_start_matches('/');
    let relative = if relative.is_empty() { "index.html" } else { relative };
    let resolved = match root.join(relative).canonicalize() {
        Ok(path) => path,
        Err(_) => {
            // SPA-style fallback to index.html keeps deep links working.
            match root.join("index.html").canonicalize() {
                Ok(path) => path,
                Err(_) => {
                    return write_response(stream, "404 Not Found", "text/plain", b"not found").is_ok();
                }
            }
        }
    };
    if !resolved.starts_with(&root) {
        return write_response(stream, "403 Forbidden", "text/plain", b"refused").is_ok();
    }
    match std::fs::read(&resolved) {
        Ok(bytes) => write_response(
            stream,
            "200 OK",
            content_type(&resolved.to_string_lossy()),
            &bytes,
        )
        .is_ok(),
        Err(_) => write_response(stream, "404 Not Found", "text/plain", b"not found").is_ok(),
    }
}

/// One invoke: the real command paths, nothing else. `pi_ipc` runs the
/// product's gated dispatch (`dispatch_envelope_gated`) from THIS thread —
/// the same bounded blocking pool and caps the product's async command
/// runs, so the acceptance run observes the product's dispatch semantics,
/// not a harness-invented thread scheme. The Tauri-CORE stand-ins (the
/// event plugin, the window plugin's maximized query and the app's own
/// `set_close_quits`) answer here — they are WebView plumbing the real
/// shell provides, not product logic; the acceptance harness fakes only
/// their observable answer, never a pi_ipc result.
fn handle_invoke(
    bridge: &Bridge,
    host_tx: &std::sync::mpsc::Sender<(HostCall, std::sync::mpsc::Sender<Value>)>,
    host_state: &Arc<IpcHostState>,
    body: &[u8],
) -> Value {
    let parsed: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(error) => return json!({ "harnessError": format!("the invoke body is not JSON: {error}") }),
    };
    let cmd = parsed.get("cmd").and_then(Value::as_str).unwrap_or("");
    let args = parsed.get("args").cloned().unwrap_or(json!({}));
    // The op trace (stderr): the acceptance driver surfaces it, so a failed
    // step shows exactly which host operations the UI attempted.
    let mut op = match cmd {
        "pi_ipc" => args.get("request").and_then(|r| r.get("op")).and_then(Value::as_str).unwrap_or("?").to_string(),
        other => other.to_string(),
    };
    let detail = match op.as_str() {
        "agent.create" => format!(
            " type={}",
            args.get("request").and_then(|r| r.get("args")).and_then(|a| a.get("type")).and_then(Value::as_str).unwrap_or("?")
        ),
        "agent.command" => format!(
            " type={}",
            args.get("request").and_then(|r| r.get("args")).and_then(|a| a.get("type")).and_then(Value::as_str).unwrap_or("?")
        ),
        _ => String::new(),
    };
    op.push_str(&detail);
    eprintln!("[harness] invoke {op}");
    // Tauri-core / app-shell stand-ins (answered without the host thread).
    match cmd {
        "plugin:event|listen" => {
            let event = args.get("event").and_then(Value::as_str).unwrap_or("").to_string();
            let handler = args.get("handler").and_then(Value::as_u64).unwrap_or(0) as u32;
            return json!(bridge.event_listen(&event, handler));
        }
        "plugin:event|unlisten" => {
            let id = args.get("eventId").and_then(Value::as_u64).unwrap_or(0);
            bridge.event_unlisten(id);
            return Value::Null;
        }
        "plugin:event|emit" | "plugin:event|emit_to" => {
            let event = args.get("event").and_then(Value::as_str).unwrap_or("").to_string();
            let payload = args.get("payload").cloned().unwrap_or(Value::Null);
            bridge.event_emit(&event, payload);
            return Value::Null;
        }
        "plugin:window|is_maximized" => return json!(false),
        // The notification plugin, headless-faithful: permission NOT granted
        // (and a denied request), so the product skips the notification
        // without erroring — exactly the real "permission off" path.
        "plugin:notification|is_permission_granted" => return json!(false),
        "plugin:notification|request_permission" => return json!("denied"),
        "plugin:window|is_focused" => return json!(false),
        // The app's own window-behavior command: acknowledged, no state kept
        // (the mock shell never reads it).
        "set_close_quits" => return Value::Null,
        _ => {}
    }
    let call = match cmd {
        "pi_ipc" => {
            let request = args.get("request").cloned().unwrap_or(Value::Null);
            let value =
                tauri::async_runtime::block_on(dispatch_envelope_gated(Arc::clone(host_state), request));
            let outcome = if value.get("ok") == Some(&Value::Bool(true)) {
                "ok".to_string()
            } else {
                format!(
                    "error {}",
                    value.get("error").and_then(|e| e.get("code")).and_then(Value::as_str).unwrap_or("?")
                )
            };
            eprintln!("[harness] invoke {op} -> {outcome}");
            return value;
        }
        "pi_ipc_subscribe_events" => {
            let Some(session) = args.get("session").and_then(Value::as_str) else {
                return json!({ "harnessError": "pi_ipc_subscribe_events needs a session" });
            };
            let Some(cb) = args.get("onEvent").and_then(channel_ref) else {
                return json!({ "harnessError": "pi_ipc_subscribe_events needs an onEvent channel" });
            };
            HostCall::SubscribeEvents { session: session.to_string(), cb }
        }
        "pi_ipc_subscribe_terminal" => {
            let Some(id) = args.get("id").and_then(Value::as_str) else {
                return json!({ "harnessError": "terminal id required" });
            };
            let Some(cb) = args.get("onOutput").and_then(channel_ref) else {
                return json!({ "harnessError": "terminal output channel required" });
            };
            HostCall::SubscribeTerminal { id: id.to_string(), cursor: args.get("cursor").and_then(Value::as_u64).unwrap_or(0), cb }
        }
        "pi_ipc_subscribe_running" => {
            let Some(cb) = args.get("onFrame").and_then(channel_ref) else {
                return json!({ "harnessError": "pi_ipc_subscribe_running needs an onFrame channel" });
            };
            HostCall::SubscribeRunning { cb }
        }
        "pi_ipc_subscribe_scheduled" => {
            let Some(cb) = args.get("onEvent").and_then(channel_ref) else {
                return json!({ "harnessError": "pi_ipc_subscribe_scheduled needs an onEvent channel" });
            };
            HostCall::SubscribeScheduled { cb }
        }
        other => return json!({ "harnessError": format!("the harness host does not implement '{other}'") }),
    };
    let (reply_tx, reply_rx) = std::sync::mpsc::channel::<Value>();
    if host_tx.send((call, reply_tx)).is_err() {
        return json!({ "harnessError": "the host thread is gone" });
    }
    match reply_rx.recv_timeout(std::time::Duration::from_secs(180)) {
        Ok(value) => value,
        Err(_) => json!({ "harnessError": "the host thread did not answer in time" }),
    }
}
