use super::*;
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::fs::OpenOptionsExt;
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT};

#[test]
fn pinned_file_ranges_and_save_clone_use_independent_cursors() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("media.bin");
    let bytes: Vec<u8> = (0..65536).map(|n| ((n / 256) % 251) as u8).collect();
    std::fs::write(&path, &bytes).unwrap();
    let mut original = std::fs::File::open(&path).unwrap();
    original.seek(SeekFrom::Start(37)).unwrap();
    let registry = Arc::new(ResourceRegistry::new());
    let handle = registry.grant_open_file(original.try_clone().unwrap(), &path, Duration::from_secs(60)).unwrap();
    let mut save = registry.clone_open_file(&handle).unwrap();
    save.seek(SeekFrom::Start(17)).unwrap();
    let mut workers = Vec::new();
    for n in 0..4u64 {
        let registry = Arc::clone(&registry);
        let handle = handle.clone();
        let expected = bytes.clone();
        workers.push(std::thread::spawn(move || {
            let start = n * 4096;
            for _ in 0..40 {
                match registry.read(&handle, "", Some((start, start + 2047))) {
                    ResourceResponse::Ok { bytes, .. } => assert_eq!(bytes, expected[start as usize..(start + 2048) as usize]),
                    result => panic!("unexpected {result:?}"),
                }
            }
        }));
    }
    for worker in workers { worker.join().unwrap(); }
    assert_eq!(original.stream_position().unwrap(), 37);
    assert_eq!(save.stream_position().unwrap(), 17);
    let mut first = [0; 1]; save.read_exact(&mut first).unwrap(); assert_eq!(first[0], bytes[17]);
    assert!(registry.revoke(&handle));
    assert!(matches!(registry.read(&handle, "", None), ResourceResponse::Denied(DenyReason::UnknownHandle)));
}

#[test]
fn pinned_windows_file_respects_response_budget_and_revoke() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("large.bin");
    let file = std::fs::File::create(&path).unwrap();
    let size = MAX_RESOURCE_RESPONSE_BYTES as u64 * 2 + 9;
    file.set_len(size).unwrap();
    let registry = ResourceRegistry::new();
    let token = registry.grant_open_file(std::fs::File::open(&path).unwrap(), &path, Duration::from_secs(60)).unwrap();
    assert!(matches!(registry.read(&token, "", None), ResourceResponse::Denied(DenyReason::TooLarge)));
    match registry.read(&token, "", Some((5, u64::MAX))) {
        ResourceResponse::Ok { bytes, total_len, range_applied, .. } => {
            assert_eq!(bytes.len(), MAX_RESOURCE_RESPONSE_BYTES); assert_eq!(total_len, size); assert!(range_applied);
        }
        other => panic!("unexpected {other:?}"),
    }
    assert!(registry.revoke(&token));
    assert!(matches!(registry.read(&token, "", None), ResourceResponse::Denied(DenyReason::UnknownHandle)));
}

#[test]
fn pinned_directory_range_rejects_escape_and_survives_rename() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("page");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("page.html"), b"0123456789").unwrap();
    let handle = std::fs::OpenOptions::new().read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(&directory).unwrap();
    let registry = ResourceRegistry::new();
    let token = registry.grant_open_directory(handle, Duration::from_secs(60)).unwrap();
    std::fs::rename(&directory, temp.path().join("old")).unwrap();
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("page.html"), b"replacement").unwrap();
    match registry.read(&token, "page.html", Some((2, 4))) {
        ResourceResponse::Ok { bytes, total_len, range_applied, .. } => { assert_eq!(bytes, b"234"); assert_eq!(total_len, 10); assert!(range_applied); }
        result => panic!("unexpected {result:?}"),
    }
    for path in ["../page.html", "/page.html", "x\\page.html", "page.html:stream"] {
        assert!(!matches!(registry.read(&token, path, None), ResourceResponse::Ok { .. }));
    }
    let old = temp.path().join("old");
    let secret = temp.path().join("secret");
    std::fs::write(&secret, b"secret").unwrap();
    match std::os::windows::fs::symlink_file(&secret, old.join("link")) {
        Ok(()) => assert!(!matches!(registry.read(&token, "link", None), ResourceResponse::Ok { .. })),
        Err(error) => eprintln!("SKIP reparse fixture: {error}"),
    }
    let expired = registry.grant_open_directory(std::fs::OpenOptions::new().read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(&directory).unwrap(), Duration::ZERO).unwrap();
    assert!(matches!(registry.read(&expired, "page.html", None), ResourceResponse::Denied(DenyReason::Expired)));
}
