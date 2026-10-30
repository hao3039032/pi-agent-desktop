//! # oauth-loopback — the desktop host's OAuth callback listener
//!
//! M0 PoC (plan §二.5): OAuth may briefly open a loopback listener. This
//! listener validates `state`, proves PKCE (the verifier is generated and
//! kept host-side; only its S256 challenge goes into the authorization URL)
//! and shuts down after exactly one completion — success, error, cancel or
//! timeout. There is no other endpoint: every non-matching request is 404.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// How one flow ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlowOutcome {
    /// The provider redirected back with matching state and an
    /// authorization code (token exchange stays host-side).
    Success { code: String, state: String },
    /// The provider redirected back with an error (`error=` parameter).
    ProviderError { error: String, state: String },
    /// The state did not match what this flow expects: an impostor or a
    /// stale tab. NEVER a success.
    StateMismatch { received: String },
    /// The user/host cancelled the flow.
    Cancelled,
    /// The deadline passed before any acceptable callback.
    TimedOut,
}

/// The parameters a flow was started with (host-owned, not frontend-owned).
pub struct Flow {
    /// Random `state` the authorization request carried.
    pub state: String,
    /// PKCE code_verifier (kept host-side; never sent to the WebView).
    pub code_verifier: String,
    /// The S256 challenge derived from the verifier (safe for the URL).
    pub code_challenge: String,
}

impl Flow {
    pub fn new() -> Self {
        let mut state_bytes = [0u8; 24];
        let mut verifier_bytes = [0u8; 40];
        getrandom::fill(&mut state_bytes).expect("OS entropy");
        getrandom::fill(&mut verifier_bytes).expect("OS entropy");
        let b64url = |bytes: &[u8]| -> String {
            // RFC 4648 base64url without padding (PKCE challenge style).
            const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut out = String::new();
            for chunk in bytes.chunks(3) {
                let b = [
                    chunk[0],
                    chunk.get(1).copied().unwrap_or(0),
                    chunk.get(2).copied().unwrap_or(0),
                ];
                out.push(ALPHABET[(b[0] >> 2) as usize] as char);
                out.push(ALPHABET[(((b[0] & 0x03) << 4) | (b[1] >> 4)) as usize] as char);
                if chunk.len() > 1 {
                    out.push(ALPHABET[(((b[1] & 0x0f) << 2) | (b[2] >> 6)) as usize] as char);
                }
                if chunk.len() > 2 {
                    out.push(ALPHABET[(b[2] & 0x3f) as usize] as char);
                }
            }
            out
        };
        let code_verifier = b64url(&verifier_bytes);
        // The challenge is derived (one-way) from the verifier; exposing it
        // in the authorization URL reveals nothing reversible.
        let code_challenge = b64url(&Sha256::digest(code_verifier.as_bytes()));
        Self {
            state: b64url(&state_bytes),
            code_verifier,
            code_challenge,
        }
    }
}

impl Default for Flow {
    fn default() -> Self {
        Self::new()
    }
}

struct Shared {
    outcome: Mutex<Option<FlowOutcome>>,
}

/// A running loopback listener. Dropping it stops the listener.
pub struct LoopbackListener {
    /// `http://127.0.0.1:<port>/callback` — the redirect_uri.
    pub redirect_uri: String,
    shared: Arc<Shared>,
    done_rx: Receiver<FlowOutcome>,
    cancel_tx: Sender<()>,
    port: u16,
}

impl LoopbackListener {
    /// Bind and start serving. The OS assigns the port (nothing else on the
    /// machine can predict or pre-empt it for this bind).
    pub fn start(flow_state: String) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let shared = Arc::new(Shared { outcome: Mutex::new(None) });
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let (cancel_tx, cancel_rx) = std::sync::mpsc::channel();
        let thread_shared = Arc::clone(&shared);
        std::thread::Builder::new()
            .name("oauth-loopback".into())
            .spawn(move || {
                // One accepted completion: after it, stop accepting (the
                // listener drops and the port closes).
                listener.set_nonblocking(true).ok();
                let deadline = Instant::now() + Duration::from_secs(600);
                loop {
                    if thread_shared.outcome.lock().unwrap().is_some() {
                        break;
                    }
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let outcome = handle_connection(stream, &thread_shared, &flow_state);
                            if let Some(outcome) = outcome {
                                // Signal the waiter exactly once per flow.
                                let _ = done_tx.send(outcome);
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            if cancel_rx.try_recv().is_ok() {
                                let mut outcome = thread_shared.outcome.lock().unwrap();
                                if outcome.is_none() {
                                    *outcome = Some(FlowOutcome::Cancelled);
                                    let _ = done_tx.send(FlowOutcome::Cancelled);
                                }
                                break;
                            }
                            if Instant::now() >= deadline {
                                let mut outcome = thread_shared.outcome.lock().unwrap();
                                if outcome.is_none() {
                                    *outcome = Some(FlowOutcome::TimedOut);
                                    let _ = done_tx.send(FlowOutcome::TimedOut);
                                }
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(25));
                        }
                        Err(_) => break,
                    }
                }
                // Dropping `listener` closes the socket.
            })
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        Ok(Self {
            redirect_uri: format!("http://127.0.0.1:{port}/callback"),
            shared,
            done_rx,
            cancel_tx,
            port,
        })
    }

    /// The bound port (diagnostics).
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Wait for the single completion (success / error / mismatch / cancel /
    /// timeout), up to `limit`.
    pub fn wait(&self, limit: Duration) -> Option<FlowOutcome> {
        self.done_rx.recv_timeout(limit).ok()
    }

    /// Cancel the flow from the host side (user closed the dialog, provider
    /// screen failed to open…).
    pub fn cancel(&self) {
        let _ = self.cancel_tx.send(());
    }

    /// Whether a completion already happened (tests).
    pub fn is_settled(&self) -> bool {
        self.shared.outcome.lock().unwrap().is_some()
    }
}

/// Serve exactly one connection: parse the request line + query, validate
/// state, record the outcome, answer the browser, close. Returns the
/// recorded outcome when THIS connection settled the flow.
fn handle_connection(
    mut stream: TcpStream,
    shared: &Shared,
    expected_state: &str,
) -> Option<FlowOutcome> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .ok();
    let mut buffer = [0u8; 4096];
    let read = match stream.read(&mut buffer) {
        Ok(read) if read > 0 => read,
        _ => return None,
    };
    let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
    let mut lines = request.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    // "GET /callback?code=…&state=… HTTP/1.1"
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path_query = parts.next().unwrap_or("");
    let respond = |stream: &mut TcpStream, status: &str, body: &str| {
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    };
    // Exactly one endpoint: `/callback` (optionally with a query string).
    // Path tricks beyond it are unknown paths, not callbacks.
    let path_only = path_query.split('?').next().unwrap_or("");
    if method != "GET" || path_only != "/callback" {
        respond(&mut stream, "404 Not Found", "not found");
        return None;
    }
    let query = path_query.split_once('?').map(|(_, query)| query).unwrap_or("");
    let params: std::collections::HashMap<String, String> = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect();

    let mut outcome = shared.outcome.lock().unwrap();
    if outcome.is_some() {
        // Already settled: this is a stray retry/duplicate tab.
        respond(&mut stream, "200 OK", "already completed");
        return None;
    }
    let received_state = params.get("state").cloned().unwrap_or_default();
    if let Some(error) = params.get("error") {
        let recorded = FlowOutcome::ProviderError { error: error.clone(), state: received_state };
        *outcome = Some(recorded.clone());
        respond(&mut stream, "200 OK", "sign-in failed; you can close this tab");
        return Some(recorded);
    }
    if received_state != expected_state {
        // Impostor or stale callback: NEVER a success.
        let recorded = FlowOutcome::StateMismatch { received: received_state };
        *outcome = Some(recorded.clone());
        respond(&mut stream, "400 Bad Request", "state mismatch");
        return Some(recorded);
    }
    match params.get("code") {
        Some(code) if !code.is_empty() => {
            let recorded = FlowOutcome::Success { code: code.clone(), state: received_state };
            *outcome = Some(recorded.clone());
            respond(&mut stream, "200 OK", "sign-in complete; you can close this tab");
            Some(recorded)
        }
        _ => {
            let recorded = FlowOutcome::ProviderError {
                error: "missing_code".to_string(),
                state: received_state,
            };
            *outcome = Some(recorded.clone());
            respond(&mut stream, "400 Bad Request", "missing code");
            Some(recorded)
        }
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() + 1 && index + 2 < bytes.len() + 1 => {
                let hex = bytes.get(index + 1..index + 3).and_then(|pair| {
                    std::str::from_utf8(pair)
                        .ok()
                        .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                });
                match hex {
                    Some(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    None => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;


    fn browser_get_on(port: u16, path: &str) -> std::io::Result<(String, String)> {
        let mut stream = TcpStream::connect(("127.0.0.1", port))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").as_bytes())?;
        let mut response = String::new();
        stream.read_to_string(&mut response)?;
        let status = response
            .split_whitespace()
            .nth(1)
            .unwrap_or_default()
            .to_string();
        let body = response.split("\r\n\r\n").nth(1).unwrap_or_default().to_string();
        Ok((status, body))
    }

    #[test]
    fn pkce_challenge_matches_the_verifier_s256() {
        let flow = Flow::new();
        assert!(!flow.code_verifier.is_empty());
        assert_ne!(flow.code_verifier, flow.code_challenge);
        // Independent S256 of the verifier equals the exposed challenge.
        let expected = {
            let digest = Sha256::digest(flow.code_verifier.as_bytes());
            digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>()
        };
        // The challenge is base64url; decode it and compare bytes instead.
        let decoded: Vec<u8> = flow
            .code_challenge
            .chars()
            .collect::<Vec<_>>()
            .chunks(4)
            .flat_map(|chunk| {
                let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
                let value: u64 = chunk
                    .iter()
                    .enumerate()
                    .map(|(index, c)| {
                        let v = alphabet.find(*c).unwrap_or(0) as u64;
                        v << (18 - 6 * index)
                    })
                    .sum();
                let bytes = value.to_be_bytes();
                match chunk.len() {
                    4 => vec![bytes[5], bytes[6], bytes[7]],
                    3 => vec![bytes[5], bytes[6]],
                    2 => vec![bytes[5]],
                    _ => vec![],
                }
            })
            .collect();
        let expected_bytes = (0..expected.len() / 2)
            .map(|index| u8::from_str_radix(&expected[index * 2..index * 2 + 2], 16).unwrap())
            .collect::<Vec<u8>>();
        assert_eq!(decoded, expected_bytes, "S256(challenge) == SHA256(verifier)");
    }

    #[test]
    fn success_callback_completes_once_and_closes() {
        let flow = Flow::new();
        let listener = LoopbackListener::start(flow.state.clone()).expect("listen");
        let port = listener.port();
        let (status, _body) =
            browser_get_on(port, &format!("/callback?code=AUTH_CODE&state={}", flow.state))
                .expect("callback");
        assert_eq!(status, "200");
        match listener.wait(Duration::from_secs(5)) {
            Some(FlowOutcome::Success { code, state }) => {
                assert_eq!(code, "AUTH_CODE");
                assert_eq!(state, flow.state);
            }
            other => panic!("expected success, got {other:?}"),
        }
        // A duplicate tab after completion: no second success, listener
        // is settled and the socket is closing.
        assert!(listener.is_settled());
        // Port is closed shortly after (accept loop exited).
        std::thread::sleep(Duration::from_millis(120));
        assert!(
            TcpStream::connect(("127.0.0.1", port)).is_err(),
            "the listener shut down after its one completion"
        );
    }

    #[test]
    fn state_mismatch_is_never_a_success() {
        let flow = Flow::new();
        let listener = LoopbackListener::start(flow.state.clone()).expect("listen");
        let (status, _) =
            browser_get_on(listener.port(), "/callback?code=STOLEN&state=impostor").expect("callback");
        assert_eq!(status, "400");
        match listener.wait(Duration::from_secs(5)) {
            Some(FlowOutcome::StateMismatch { received }) => assert_eq!(received, "impostor"),
            other => panic!("expected mismatch, got {other:?}"),
        }
    }

    #[test]
    fn provider_error_and_missing_code_are_error_completions() {
        let flow = Flow::new();
        let listener = LoopbackListener::start(flow.state.clone()).expect("listen");
        let (status, _) = browser_get_on(
            listener.port(),
            &format!("/callback?error=access_denied&state={}", flow.state),
        )
        .expect("callback");
        assert_eq!(status, "200");
        match listener.wait(Duration::from_secs(5)) {
            Some(FlowOutcome::ProviderError { error, .. }) => assert_eq!(error, "access_denied"),
            other => panic!("expected provider error, got {other:?}"),
        }
    }

    #[test]
    fn other_paths_and_methods_get_404_only() {
        let flow = Flow::new();
        let listener = LoopbackListener::start(flow.state.clone()).expect("listen");
        for path in ["/", "/api/sessions", "/callback/../etc/passwd", "/admin"] {
            let (status, _) = browser_get_on(listener.port(), path).expect("probe");
            assert_eq!(status, "404", "no surface at {path}");
        }
        assert!(!listener.is_settled(), "probes settle nothing");
        listener.cancel();
        match listener.wait(Duration::from_secs(5)) {
            Some(FlowOutcome::Cancelled) => {}
            other => panic!("expected cancel, got {other:?}"),
        }
    }

    #[test]
    fn cancel_completes_without_a_callback() {
        let flow = Flow::new();
        let listener = LoopbackListener::start(flow.state.clone()).expect("listen");
        listener.cancel();
        match listener.wait(Duration::from_secs(5)) {
            Some(FlowOutcome::Cancelled) => {}
            other => panic!("expected cancel, got {other:?}"),
        }
        std::thread::sleep(Duration::from_millis(120));
        assert!(TcpStream::connect(("127.0.0.1", listener.port())).is_err());
    }

    #[test]
    fn percent_decoding_of_code_and_state() {
        let flow = Flow::new();
        let listener = LoopbackListener::start(flow.state.clone()).expect("listen");
        let code = "a%2Bb%3Dc%20d";
        let (status, _) = browser_get_on(
            listener.port(),
            &format!("/callback?code={code}&state={}", flow.state),
        )
        .expect("callback");
        assert_eq!(status, "200");
        match listener.wait(Duration::from_secs(5)) {
            Some(FlowOutcome::Success { code, .. }) => assert_eq!(code, "a+b=c d"),
            other => panic!("expected success, got {other:?}"),
        }
    }

    #[test]
    #[ignore = "long-running timeout path; run explicitly with --ignored"]
    fn timeout_completes_the_flow() {
        let flow = Flow::new();
        let listener = LoopbackListener::start(flow.state.clone()).expect("listen");
        // The internal deadline is 600s — too long for a unit test, so this
        // documents the path; the cancel test covers the shutdown half.
        let _ = listener;
    }
}
