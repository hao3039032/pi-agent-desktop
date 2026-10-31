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
    let (size, revision) = registry.file_metadata(&handle).unwrap();
    assert_eq!(size, 6);
    std::fs::write(&path, b"abcdefg").unwrap();
    let (new_size, new_revision) = registry.file_metadata(&handle).unwrap();
    assert_eq!(new_size, 7);
    assert_ne!(revision, new_revision);
    assert!(result.headers()["content-security-policy"].to_str().unwrap().contains("sandbox"));
    assert_eq!(respond(&registry, request(&handle).header("Range", "bytes=99-").body(vec![]).unwrap()).status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(respond(&registry, request("not-a-token").body(vec![]).unwrap()).status(), StatusCode::NOT_FOUND);
    assert!(registry.revoke(&handle));
    assert_eq!(respond(&registry, request(&handle).body(vec![]).unwrap()).status(), StatusCode::NOT_FOUND);
    let expired = registry.grant_open_file(std::fs::File::open(&path).unwrap(), &path, Duration::ZERO).unwrap();
    assert_eq!(respond(&registry, request(&expired).body(vec![]).unwrap()).status(), StatusCode::NOT_FOUND);
}

#[test]
fn raster_image_handle_uses_the_same_protocol_and_ranges() {
    let registry = ResourceRegistry::new();
    let handle = registry.grant_image_bytes(b"012345".to_vec(), "image/png", Duration::from_secs(30)).unwrap();
    let request = Request::builder().uri(format!("pi-resource://localhost/{handle}"))
        .header("Range", "bytes=2-4").body(vec![]).unwrap();
    let response = respond(&registry, request);
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(response.headers()["content-length"], "3");
    assert_eq!(response.headers()["content-range"], "bytes 2-4/6");
    assert_eq!(response.body(), b"234");
}

#[cfg(unix)]
#[test]
fn preview_directory_resolves_assets_but_not_symlinks_or_traversal() {
    let dir = tempfile::tempdir().unwrap();
    let assets = dir.path().join("assets");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), b"<link rel=stylesheet href=style.css>").unwrap();
    std::fs::write(assets.join("style.css"), b"body { color: red }").unwrap();
    let outside = dir.path().join("secret.txt");
    std::fs::write(&outside, b"secret").unwrap();
    std::os::unix::fs::symlink(&outside, assets.join("leak")).unwrap();
    let registry = ResourceRegistry::new();
    let handle = registry.grant_open_directory(std::fs::File::open(&assets).unwrap(), Duration::from_secs(30)).unwrap();
    let request = |path: &str| Request::builder().uri(format!("pi-resource://localhost/{handle}/{path}")).body(vec![]).unwrap();
    let html = respond(&registry, request("index.html"));
    assert_eq!(html.status(), StatusCode::OK);
    assert!(html.headers()["content-security-policy"].to_str().unwrap().contains("sandbox allow-same-origin"));
    assert!(!html.headers()["content-security-policy"].to_str().unwrap().contains("allow-scripts"));
    let css = respond(&registry, request("style.css?v=1"));
    assert_eq!(css.headers()["content-type"], "text/css; charset=utf-8");
    assert_eq!(css.body(), b"body { color: red }");
    assert_eq!(respond(&registry, request("leak")).status(), StatusCode::NOT_FOUND);
    assert_eq!(respond(&registry, request("%2e%2e/secret.txt")).status(), StatusCode::NOT_FOUND);
    assert_eq!(respond(&registry, request("%2fsecret.txt")).status(), StatusCode::NOT_FOUND);
    assert!(registry.revoke(&handle));
    assert_eq!(respond(&registry, request("style.css")).status(), StatusCode::NOT_FOUND);
}
