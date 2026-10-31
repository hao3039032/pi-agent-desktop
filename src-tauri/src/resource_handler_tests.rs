use super::*;
use std::time::Duration;

#[test]
fn token_range_revoke_and_expiry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.txt");
    std::fs::write(&path, b"abcdef").unwrap();
    let registry = ResourceRegistry::new();
    let handle = registry.grant_open_file(std::fs::File::open(&path).unwrap(), &path, Duration::from_secs(30)).unwrap();
    let request = |token: &str| Request::builder().uri(format!("pi-resource://localhost/{token}"));
    let result = respond(&registry, request(&handle).header("Range", "bytes=1-3").body(vec![]).unwrap());
    assert_eq!(result.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(result.headers()["content-range"], "bytes 1-3/6");
    assert_eq!(result.body(), b"bcd");
    assert!(result.headers()["content-security-policy"].to_str().unwrap().contains("sandbox"));
    assert_eq!(respond(&registry, request(&handle).header("Range", "bytes=99-").body(vec![]).unwrap()).status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(respond(&registry, request("not-a-token").body(vec![]).unwrap()).status(), StatusCode::NOT_FOUND);
    assert!(registry.revoke(&handle));
    assert_eq!(respond(&registry, request(&handle).body(vec![]).unwrap()).status(), StatusCode::NOT_FOUND);
    let expired = registry.grant_open_file(std::fs::File::open(&path).unwrap(), &path, Duration::ZERO).unwrap();
    assert_eq!(respond(&registry, request(&expired).body(vec![]).unwrap()).status(), StatusCode::NOT_FOUND);
}
