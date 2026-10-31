//! Capability-free, token-only media responses for the desktop WebView.
use resource_protocol::{ResourceRegistry, ResourceResponse};
use tauri::http::{Request, Response, StatusCode};

#[cfg(test)]
#[path = "resource_handler_tests.rs"]
mod tests;

pub fn respond(registry: &ResourceRegistry, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let empty = |status| Response::builder().status(status).header("Cache-Control", "no-store").body(Vec::new()).unwrap();
    if request.method() != tauri::http::Method::GET { return empty(StatusCode::METHOD_NOT_ALLOWED); }
    let token = request.uri().path().strip_prefix('/').unwrap_or("");
    if token.len() != 32 || !token.bytes().all(|b| b.is_ascii_hexdigit()) || request.uri().query().is_some() {
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
    match registry.read(token, "", range) {
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
                .header("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
            if let Some((start, _)) = range.filter(|_| range_applied) {
                response = response.header("Content-Range", format!("bytes {start}-{}/{total_len}", start + bytes.len() as u64 - 1));
            }
            response.body(bytes).unwrap()
        }
    }
}
