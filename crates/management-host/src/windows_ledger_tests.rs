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
fn windows_transaction_lock_excludes_other_openers() {
    let dir = tempfile::tempdir().unwrap();
    let base = super::windows_storage::PinnedDirectory::open(dir.path(), false, true).unwrap().unwrap();
    let first = base.transaction().unwrap();
    assert!(base.transaction().is_err());
    drop(first);
    assert!(base.transaction().is_ok());
}
