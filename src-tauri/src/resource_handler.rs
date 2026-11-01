//! Capability-free, token-only media responses for the desktop WebView.
use resource_protocol::{DenyReason, ResourceRegistry, ResourceResponse};
use tauri::http::{Request, Response, StatusCode};

#[cfg(test)]
#[path = "resource_handler_tests.rs"]
mod tests;

fn decode_subpath(raw: &str) -> Option<String> {
    let mut decoded = Vec::with_capacity(raw.len());
    let mut bytes = raw.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let hex = [bytes.next()?, bytes.next()?];
            let text = std::str::from_utf8(&hex).ok()?;
            let value = u8::from_str_radix(text, 16).ok()?;
            if value == b'/' || value == b'\\' || value == 0 { return None; }
            decoded.push(value);
        } else { decoded.push(byte); }
    }
    String::from_utf8(decoded).ok()
}

pub fn respond(registry: &ResourceRegistry, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let empty = |status| Response::builder().status(status).header("Cache-Control", "no-store").body(Vec::new()).unwrap();
    if request.method() != tauri::http::Method::GET { return empty(StatusCode::METHOD_NOT_ALLOWED); }
    let path = request.uri().path().strip_prefix('/').unwrap_or("");
    let (token, raw_subpath) = path.split_once('/').unwrap_or((path, ""));
    let Some(subpath) = decode_subpath(raw_subpath) else { return empty(StatusCode::NOT_FOUND) };
    if token.len() != 32 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return empty(StatusCode::NOT_FOUND);
    }
    let range = match request.headers().get("range") {
        None => None,
        Some(value) => {
            let parsed = value.to_str().ok().and_then(|s| s.strip_prefix("bytes="))
                .and_then(|s| s.split_once('-'))
                .and_then(|(a, b)| Some((a.parse::<u64>().ok()?, if b.is_empty() { u64::MAX } else { b.parse().ok()? })))
                .filter(|(a, b)| a <= b);
            match parsed { Some(r) => Some(r), None => return empty(StatusCode::RANGE_NOT_SATISFIABLE) }
        }
    };
    match registry.read(token, &subpath, range) {
        ResourceResponse::Denied(DenyReason::TooLarge) => Response::builder()
            .status(StatusCode::PAYLOAD_TOO_LARGE)
            .header("Content-Type", "text/plain; charset=utf-8")
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-store")
            .body(b"Resource exceeds the preview limit. Use Download or a range-capable viewer.".to_vec()).unwrap(),
        ResourceResponse::Denied(DenyReason::Busy) => empty(StatusCode::SERVICE_UNAVAILABLE),
        ResourceResponse::Denied(_) => empty(StatusCode::NOT_FOUND),
        ResourceResponse::Ok { mime, bytes, total_len, range_applied } => {
            if range_applied && bytes.is_empty() {
                return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header("Content-Range", format!("bytes */{total_len}"))
                    .header("Cache-Control", "no-store").body(Vec::new()).unwrap();
            }
            let mut response = Response::builder().status(if range_applied { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
                .header("Content-Type", mime).header("Content-Length", bytes.len().to_string())
                .header("Accept-Ranges", "bytes").header("Cache-Control", "no-store")
                .header("X-Content-Type-Options", "nosniff")
                .header("Referrer-Policy", "no-referrer")
                .header("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; sandbox allow-same-origin");
            if range_applied {
                let start = range.map(|(start, _)| start).unwrap_or(0);
                response = response.header("Content-Range", format!("bytes {start}-{}/{total_len}", start + bytes.len() as u64 - 1));
            }
            response.body(bytes).unwrap()
        }
    }
}
