use super::{ledger::{MutationDescriptor, OperationLedger, OperationScope}, target_key::ManagementTargetKey};

#[test]
fn windows_key_stays_stable_and_missing_or_corrupt_key_with_ledger_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let first = ManagementTargetKey::load_or_create(dir.path()).unwrap().fingerprint("fixture").unwrap();
    assert_eq!(first, ManagementTargetKey::load_or_create(dir.path()).unwrap().fingerprint("fixture").unwrap());
    let ledger = OperationLedger::open(dir.path()).unwrap();
    drop(ledger);
    let key = dir.path().join("pi-web/management-target-key.v1");
    std::fs::remove_file(&key).unwrap();
    assert!(ManagementTargetKey::load_or_create(dir.path()).is_err());
    std::fs::write(&key, "corrupt").unwrap();
    assert!(ManagementTargetKey::load_or_create(dir.path()).is_err());
}

#[test]
fn windows_ledger_pending_survives_reopen_and_blocks_mutations() {
    let dir = tempfile::tempdir().unwrap();
    ManagementTargetKey::load_or_create(dir.path()).unwrap();
    let descriptor = MutationDescriptor::new("auth.apiKeyStore", OperationScope::Global).unwrap();
    let ledger = OperationLedger::open(dir.path()).unwrap();
    let id = ledger.begin(&descriptor).unwrap();
    let reopened = OperationLedger::open(dir.path()).unwrap();
    assert_eq!(reopened.list_pending().unwrap()[0].operation_id, id);
    assert!(reopened.begin(&descriptor).is_err());
    assert!(OperationLedger::inspect_unresolved(dir.path()).unwrap());
    ledger.finish(&id).unwrap();
    assert!(reopened.list_pending().unwrap().is_empty());
    assert!(!OperationLedger::inspect_unresolved(dir.path()).unwrap());
    let next = reopened.begin(&descriptor).unwrap();
    reopened.finish(&next).unwrap();
}

#[test]
fn windows_hardlinked_target_key_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    ManagementTargetKey::load_or_create(dir.path()).unwrap();
    std::fs::hard_link(dir.path().join("pi-web/management-target-key.v1"), dir.path().join("duplicate")).unwrap();
    assert!(ManagementTargetKey::load_or_create(dir.path()).is_err());
}

#[test]
fn windows_untrusted_dacl_on_agent_is_rejected() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{Foundation::LocalFree, Security::{DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SetFileSecurityW}, Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW};
    let dir = tempfile::tempdir().unwrap();
    let path: Vec<u16> = dir.path().as_os_str().encode_wide().chain(Some(0)).collect();
    let sddl: Vec<u16> = "D:P(A;;FA;;;WD)".encode_utf16().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    assert_ne!(unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) }, 0);
    let result = unsafe { SetFileSecurityW(path.as_ptr(), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, descriptor) };
    unsafe { LocalFree(descriptor); }
    assert_ne!(result, 0);
    assert!(ManagementTargetKey::load_or_create(dir.path()).is_err());
}

#[test]
fn windows_key_handle_rejects_untrusted_read_acl() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{Foundation::LocalFree, Security::{DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SetFileSecurityW}, Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW};
    let dir = tempfile::tempdir().unwrap();
    ManagementTargetKey::load_or_create(dir.path()).unwrap();
    let path = dir.path().join("pi-web/management-target-key.v1");
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let sddl: Vec<u16> = "D:P(A;;FA;;;OW)(A;;FR;;;WD)".encode_utf16().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    assert_ne!(unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) }, 0);
    let result = unsafe { SetFileSecurityW(wide.as_ptr(), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, descriptor) };
    unsafe { LocalFree(descriptor); }
    assert_ne!(result, 0);
    assert!(ManagementTargetKey::load_or_create(dir.path()).is_err());
}

#[test]
fn windows_failed_no_replace_publish_preserves_both_files() {
    let dir = tempfile::tempdir().unwrap();
    let base = super::windows_storage::PinnedDirectory::open(dir.path(), false, true).unwrap().unwrap();
    let _transaction = base.transaction().unwrap();
    use std::io::Write;
    for (name, bytes) in [("source.tmp", b"new".as_slice()), ("target", b"old".as_slice())] {
        let mut file = base.file(name, true).unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
    }
    assert!(base.publish("source.tmp", "target", false).is_err());
    assert_eq!(std::fs::read(base.path.join("target")).unwrap(), b"old");
    assert_eq!(std::fs::read(base.path.join("source.tmp")).unwrap(), b"new");
}

#[test]
fn windows_transaction_lock_excludes_other_openers() {
    let dir = tempfile::tempdir().unwrap();
    let base = super::windows_storage::PinnedDirectory::open(dir.path(), false, true).unwrap().unwrap();
    let first = base.transaction().unwrap();
    assert!(base.transaction().is_err());
    drop(first);
    assert!(base.transaction().is_ok());
}

#[test]
fn windows_competing_ledger_instances_admit_only_one_mutation() {
    let dir = tempfile::tempdir().unwrap();
    ManagementTargetKey::load_or_create(dir.path()).unwrap();
    let a = OperationLedger::open(dir.path()).unwrap();
    let b = OperationLedger::open(dir.path()).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = [a, b].into_iter().map(|ledger| {
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            let descriptor = MutationDescriptor::new("auth.apiKeyStore", OperationScope::Global).unwrap();
            barrier.wait();
            ledger.begin(&descriptor)
        })
    }).collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(OperationLedger::inspect(dir.path()).unwrap().len(), 1);
}

#[test]
fn windows_unfinished_publication_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    ManagementTargetKey::load_or_create(dir.path()).unwrap();
    let base = dir.path().join("pi-web");
    std::fs::write(base.join(".management-target-key-interrupted.tmp"), b"partial").unwrap();
    assert!(ManagementTargetKey::load_or_create(dir.path()).is_err());
    std::fs::remove_file(base.join(".management-target-key-interrupted.tmp")).unwrap();
    let ledger = OperationLedger::open(dir.path()).unwrap();
    std::fs::write(base.join("management-operations/.interrupted.tmp"), b"partial").unwrap();
    assert!(ledger.begin(&MutationDescriptor::new("auth.apiKeyStore", OperationScope::Global).unwrap()).is_err());
    assert!(OperationLedger::inspect(dir.path()).is_err());
}

#[test]
fn windows_reparse_storage_directory_is_rejected() {
    use std::os::windows::process::CommandExt;
    let dir = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let link = dir.path().join("pi-web");
    let result = std::process::Command::new("cmd.exe").args(["/C", "mklink", "/J"]).arg(&link).arg(target.path()).creation_flags(0x08000000).output().unwrap();
    assert!(result.status.success(), "junction fixture failed: {}", String::from_utf8_lossy(&result.stderr));
    assert!(ManagementTargetKey::load_or_create(dir.path()).is_err());
    std::fs::remove_dir(link).unwrap();
}

#[test]
fn windows_unknown_survives_process_exit() {
    const ENV: &str = "PI_TEST_WINDOWS_LEDGER_CHILD_DIR";
    if let Some(path) = std::env::var_os(ENV) {
        let ledger = OperationLedger::open(std::path::Path::new(&path)).unwrap();
        ledger.begin(&MutationDescriptor::new("auth.apiKeyStore", OperationScope::Global).unwrap()).unwrap();
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    ManagementTargetKey::load_or_create(dir.path()).unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "windows_ledger_tests::windows_unknown_survives_process_exit", "--nocapture"])
        .env(ENV, dir.path()).status().unwrap();
    assert!(status.success());
    let ledger = OperationLedger::open(dir.path()).unwrap();
    assert_eq!(ledger.list_pending().unwrap().len(), 1);
    assert!(ledger.begin(&MutationDescriptor::new("auth.apiKeyDelete", OperationScope::Global).unwrap()).is_err());
}
