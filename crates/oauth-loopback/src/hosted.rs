//! A task-owned MCP callback socket. Binding precedes arming with SDK state.
use std::io::{self, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
pub enum Callback {
    Code { code: String, iss: Option<String> },
    Denied,
}

pub struct HostedListener {
    socket: TcpListener,
    paths: Vec<String>,
    pub redirect_uri: String,
}

impl HostedListener {
    pub fn bind(host: &str, redirect_host: &str, port: Option<u16>, required: bool, path: &str, extra_paths: &[String]) -> io::Result<Self> {
        let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "invalid loopback callback settings");
        let address: IpAddr = host.parse().map_err(|_| invalid())?;
        if !address.is_loopback() || !matches!(host, "127.0.0.1" | "::1")
            || !matches!(redirect_host, "127.0.0.1" | "localhost" | "::1")
            || (host == "::1") != (redirect_host == "::1")
            || !valid_path(path) || extra_paths.len() > 1 || extra_paths.iter().any(|p| !valid_path(p)) {
            return Err(invalid());
        }
        let preferred = port.unwrap_or(0);
        let socket = match TcpListener::bind((address, preferred)) {
            Ok(socket) => socket,
            Err(_) if preferred != 0 && !required => TcpListener::bind((address, 0))?,
            Err(e) => return Err(e),
        };
        socket.set_nonblocking(true)?;
        let actual_port = socket.local_addr()?.port();
        let host_url = if redirect_host == "::1" { "[::1]" } else { redirect_host };
        let mut paths = vec![path.to_owned()];
        paths.extend_from_slice(extra_paths);
        Ok(Self { socket, paths, redirect_uri: format!("http://{host_url}:{actual_port}{path}") })
    }

    /// Process at most one connection, without blocking on accept. Wrong state,
    /// path and malformed requests do not consume the one-shot callback.
    pub fn poll(&self, state: &str, path: &str) -> io::Result<Option<Callback>> {
        if state.is_empty() || !self.paths.iter().any(|allowed| allowed == path) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid callback arm"));
        }
        match self.socket.accept() {
            Ok((stream, _)) => Ok(handle(stream, state, path)),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(error),
        }
    }
}

fn valid_path(path: &str) -> bool {
    path.starts_with('/') && path.len() <= 1024 && !path.chars().any(|c| c.is_control() || matches!(c, '?' | '#' | ' '))
}

fn handle(mut stream: TcpStream, state: &str, expected_path: &str) -> Option<Callback> {
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut request = Vec::new();
    let mut chunk = [0u8; 512];
    while !request.windows(2).any(|x| x == b"\r\n") && request.len() <= 16384 {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else { return None };
        if remaining.is_zero() || stream.set_read_timeout(Some(remaining)).is_err() { return None; }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return None,
            Ok(n) => request.extend_from_slice(&chunk[..n]),
        }
    }
    let line = match std::str::from_utf8(&request) { Ok(s) => s.split("\r\n").next().unwrap_or(""), Err(_) => return None };
    if line.len() > 16384 { return None; }
    let mut words = line.split_whitespace();
    let method = words.next();
    let target = words.next().unwrap_or("");
    let version = words.next();
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if method != Some("GET") || version != Some("HTTP/1.1") || words.next().is_some() || path != expected_path {
        respond(&mut stream, "404 Not Found", "not found"); return None;
    }
    let mut values = std::collections::HashMap::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = super::percent_decode(key);
        if matches!(key.as_str(), "state" | "code" | "error" | "iss") && values.contains_key(&key) {
            respond(&mut stream, "400 Bad Request", "invalid callback"); return None;
        }
        values.insert(key, super::percent_decode(value));
    }
    if values.get("state").map(String::as_str) != Some(state) {
        respond(&mut stream, "400 Bad Request", "invalid callback"); return None;
    }
    if values.contains_key("error") {
        respond(&mut stream, "400 Bad Request", "sign-in denied"); return Some(Callback::Denied);
    }
    match values.remove("code") {
        Some(code) if !code.is_empty() => {
            respond(&mut stream, "200 OK", "Authorization received. You may close this page.");
            Some(Callback::Code { code, iss: values.remove("iss") })
        }
        _ => { respond(&mut stream, "400 Bad Request", "missing code"); None }
    }
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::thread;
    #[test]
    fn binds_before_state_and_rejects_stale_and_wrong_path() {
        let listener = HostedListener::bind("127.0.0.1", "localhost", None, false, "/callback", &[]).unwrap();
        let port = listener.socket.local_addr().unwrap().port();
        for (target, expected) in [("/callback?state=old&code=stolen", None), ("/callback?state=old&error=denied", None), ("/callback?state=good&state=old&code=stolen", None), ("/other?state=good&code=stolen", None), ("/callback?state=good&code=ok&iss=issuer", Some(Callback::Code { code: "ok".into(), iss: Some("issuer".into()) }))] {
            let t = thread::spawn(move || { let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap(); write!(s, "GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap(); let mut buf = String::new(); s.read_to_string(&mut buf).unwrap(); });
            let result = loop { if let Some(result) = listener.poll("good", "/callback").unwrap() { break Some(result); } if t.is_finished() { break None; } thread::sleep(Duration::from_millis(2)); };
            t.join().unwrap();
            assert_eq!(result, expected);
        }
    }
    #[test]
    fn required_port_conflicts_but_preferred_falls_back() {
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(HostedListener::bind("127.0.0.1", "localhost", Some(port), true, "/callback", &[]).is_err());
        let actual = HostedListener::bind("127.0.0.1", "localhost", Some(port), false, "/callback", &[]).unwrap();
        assert_ne!(actual.socket.local_addr().unwrap().port(), port);
        assert!(HostedListener::bind("0.0.0.0", "localhost", None, false, "/callback", &[]).is_err());
    }
}
