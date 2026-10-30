//! Post-processing of one stdout frame (the part between two `\n` bytes).
//!
//! The protocol frames strictly on LF (docs/rpc.md warns that Node's readline
//! also splits on U+2028/U+2029, which are valid inside JSON strings, so
//! framing never looks at those). `\r` before the LF is tolerated. Blank
//! lines are skipped. A frame that is not valid UTF-8 or not a JSON object is
//! reported as a diagnostic line and dropped — the stream continues.

/// Result of framing one raw line (LF already stripped).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FramedLine {
    /// A parsed record (always a JSON object).
    Record(serde_json::Value),
    /// Skipped without a diagnostic (blank / whitespace only).
    Blank,
    /// Dropped with a diagnostic message for the log.
    Unparseable(String),
}

const UNPARSEABLE_PREVIEW: usize = 200;

/// Process one raw frame (without the trailing LF).
pub fn frame_line(raw: &[u8]) -> FramedLine {
    let mut bytes = raw;
    if bytes.last() == Some(&b'\r') {
        bytes = &bytes[..bytes.len() - 1];
    }
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return FramedLine::Blank;
    }
    match std::str::from_utf8(bytes) {
        Ok(line) => match serde_json::from_str::<serde_json::Value>(line) {
            Ok(value) if value.is_object() => FramedLine::Record(value),
            _ => FramedLine::Unparseable(preview(line)),
        },
        Err(_) => FramedLine::Unparseable("<invalid utf-8>".to_string()),
    }
}

fn preview(line: &str) -> String {
    let cut: String = line.chars().take(UNPARSEABLE_PREVIEW).collect();
    format!("unparseable rpc line: {cut}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_object_lines() {
        assert_eq!(frame_line(br#"{"type":"response"}"#), FramedLine::Record(json!({"type": "response"})));
    }

    #[test]
    fn tolerates_crlf() {
        assert_eq!(frame_line(b"{\"a\":1}\r"), FramedLine::Record(json!({"a": 1})));
    }

    #[test]
    fn skips_blank_lines() {
        assert_eq!(frame_line(b""), FramedLine::Blank);
        assert_eq!(frame_line(b"   "), FramedLine::Blank);
    }

    #[test]
    fn u2028_is_data_not_a_separator() {
        // A record whose string value contains U+2028/U+2029 stays one frame.
        let line = "{\"message\":\"a\u{2028}b\u{2029}c\"}".as_bytes();
        match frame_line(line) {
            FramedLine::Record(value) => {
                assert_eq!(value["message"], "a\u{2028}b\u{2029}c");
            }
            other => panic!("expected a record, got {other:?}"),
        }
    }

    #[test]
    fn reports_unparseable_lines() {
        assert!(matches!(frame_line(b"not json"), FramedLine::Unparseable(_)));
        assert!(matches!(frame_line(b"[1,2]"), FramedLine::Unparseable(_)));
        assert!(matches!(frame_line(b"\xff\xfe"), FramedLine::Unparseable(_)));
    }
}
