use super::ledger::*;
use super::{ManagementHost, ManagementSpawnConfig, TaskKind, TaskStatus};
use std::time::{Duration, Instant};

fn begin(ledger: &OperationLedger, op: &str) -> Result<String, String> {
    ledger.begin(&MutationDescriptor::new(op, OperationScope::Global)?)
}

#[test]
fn mcp_credential_target_rejects_raw_keys_and_detects_legacy_aliases() {
    let a = McpCredentialTarget::new("a".repeat(64), "c".repeat(64)).unwrap();
    let alias = McpCredentialTarget::new("b".repeat(64), "c".repeat(64)).unwrap();
    let other = McpCredentialTarget::new("d".repeat(64), "e".repeat(64)).unwrap();
    assert!(a.conflicts(&alias));
    assert!(!a.conflicts(&other));
    assert!(McpCredentialTarget::new("https://user:secret@example.test".into(), "c".repeat(64)).is_err());
    assert!(McpCredentialTarget::new("A".repeat(64), "c".repeat(64)).is_err());
}

#[test]
fn read_only_inspection_never_creates_or_clears_evidence() {
    let temp = tempfile::tempdir().unwrap();
    assert!(OperationLedger::inspect(temp.path()).unwrap().is_empty());
    assert!(!temp.path().join("pi-web").exists());
    let ledger = OperationLedger::open(temp.path()).unwrap();
    let id = begin(&ledger, "auth.logout").unwrap();
    assert_eq!(OperationLedger::inspect(temp.path()).unwrap()[0].operation_id, id);
    assert_eq!(ledger.list_pending().unwrap().len(), 1);
}

#[test]
fn pending_survives_reopen_and_success_finishes_only_own_record() {
    let temp = tempfile::tempdir().unwrap();
    let ledger = OperationLedger::open(temp.path()).unwrap();
    let id = begin(&ledger, "auth.apiKeyStore").unwrap();
    let reopened = OperationLedger::open(temp.path()).unwrap();
    let pending = reopened.list_pending().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].operation_id, id);
    assert_eq!(pending[0].target, OperationTarget::Credentials);
    assert!(begin(&reopened, "models.setDefault").is_err());
    assert!(ledger.finish("not-an-id").is_err());
    ledger.finish(&id).unwrap();
    assert!(reopened.list_pending().unwrap().is_empty());
}

#[test]
fn bad_record_and_unsafe_directory_fail_closed() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let ledger = OperationLedger::open(temp.path()).unwrap();
    let dir = temp.path().join("pi-web/management-operations");
    std::fs::write(dir.join(format!("{}.json", uuid::Uuid::new_v4())), b"broken").unwrap();
    assert!(ledger.list_pending().is_err());
    assert!(begin(&ledger, "auth.logout").is_err());
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(OperationLedger::open(temp.path()).is_err());
}

#[test]
fn capacity_is_bounded_without_discarding_pending() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let ledger = OperationLedger::open(temp.path()).unwrap();
    let dir = temp.path().join("pi-web/management-operations");
    for _ in 0..128 {
        let id = uuid::Uuid::new_v4().to_string();
        let path = dir.join(format!("{id}.json"));
        std::fs::write(&path, serde_json::json!({"version":1,"operationId":id,"operation":"auth.logout","scope":"global","target":"credentials","phase":"pending","createdAtMs":1}).to_string()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert_eq!(ledger.list_pending().unwrap().len(), 128);
    assert!(begin(&ledger, "auth.apiKeyStore").is_err());
    assert_eq!(std::fs::read_dir(dir).unwrap().count(), 128);
}

const CHILD: &str = r##"#!/usr/bin/python3
import sys, json, base64, os
for line in sys.stdin:
    r=json.loads(line)
    if r.get('type') != 'prompt': continue
    parts=r['message'].split(' ')
    rid=parts[1]
    data=json.loads(base64.urlsafe_b64decode(parts[2] + '='*((-len(parts[2]))%4)))
    root=os.environ['PI_CODING_AGENT_DIR']
    records=os.listdir(os.path.join(root,'pi-web','management-operations'))
    assert len(records) == 1
    record=open(os.path.join(root,'pi-web','management-operations',records[0])).read()
    assert 'secret-fixture' not in record and json.loads(record)['phase'] == 'pending'
    with open(os.path.join(root,'effect-marker'),'a') as marker: marker.write('effect\n')
    print(json.dumps({'type':'response','id':r['id'],'success':True,'data':{'disposition':'handled'}}),flush=True)
    if os.environ.get('MODE') == 'die': os._exit(2)
    result={'results':[{'error':'partial write'}]} if os.environ.get('MODE') == 'partial' else {'success':True}
    body={'rid':rid,'nonce':data['nonce'],'ok':True,'result':result}
    print(json.dumps({'type':'extension_ui_request','id':'notify','method':'notify','message':'PI_WEB_MGMT_V1 '+json.dumps(body)}),flush=True)
"##;

fn fixture(temp: &tempfile::TempDir, mode: &str) -> ManagementSpawnConfig {
    use std::os::unix::fs::PermissionsExt;
    let executable = temp.path().join("child.py");
    std::fs::write(&executable, CHILD).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    ManagementSpawnConfig { executable: executable.to_str().unwrap().into(), agent_dir: Some(temp.path().to_path_buf()), extensions: vec![], env: vec![("MODE".into(), mode.into())] }
}

#[test]
fn host_rejects_changed_agent_directory_even_with_an_existing_instance() {
    use std::sync::{Arc, Mutex};
    let temp = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let pinned = Arc::new(Mutex::new(temp.path().to_path_buf()));
    let check = Arc::clone(&pinned);
    let host = ManagementHost::with_agent_dir_check(Arc::new(move |path| {
        if *check.lock().unwrap() == path { Ok(()) } else { Err("agent dir changed".into()) }
    }));
    let config = fixture(&temp, "ok");
    let instance = host.instance("global", &config).unwrap();
    *pinned.lock().unwrap() = other.path().to_path_buf();
    assert!(host.instance("global", &config).is_err());
    assert!(instance.start_task("auth.logout", serde_json::json!({}), Duration::from_secs(1), TaskKind::Mutation).is_err());
    assert!(OperationLedger::open(temp.path()).unwrap().list_pending().unwrap().is_empty());
    host.shutdown_all(Duration::from_secs(1));
}

#[test]
fn partial_mutation_result_stays_pending() {
    let temp = tempfile::tempdir().unwrap();
    let config = fixture(&temp, "partial");
    let host = ManagementHost::new();
    let instance = host.instance("global", &config).unwrap();
    let handle = instance.start_serial_task("plugins.setEnabled", serde_json::json!({}), Duration::from_secs(2)).unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if instance.task_snapshot(&handle).unwrap().status == TaskStatus::Unknown { break; }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(OperationLedger::open(temp.path()).unwrap().list_pending().unwrap().len(), 1);
    host.shutdown_all(Duration::from_secs(1));
}

#[test]
fn real_child_success_and_exit_after_admission_preserve_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let config = fixture(&temp, "ok");
    let host = ManagementHost::new();
    let instance = host.instance("global", &config).unwrap();
    let result = instance.management_call("auth.apiKeyStore", serde_json::json!({"apiKey":"secret-fixture"}), Duration::from_secs(5)).unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(std::fs::read_to_string(temp.path().join("effect-marker")).unwrap(), "effect\n");
    let terminal = std::fs::read_to_string(std::fs::read_dir(temp.path().join("pi-web/management-operations")).unwrap().next().unwrap().unwrap().path()).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&terminal).unwrap()["phase"], "succeeded");
    assert!(OperationLedger::open(temp.path()).unwrap().list_pending().unwrap().is_empty());
    host.shutdown_all(Duration::from_secs(1));

    let config = fixture(&temp, "die");
    let host = ManagementHost::new();
    let instance = host.instance("global", &config).unwrap();
    let id = instance.start_task("auth.apiKeyStore", serde_json::json!({"apiKey":"secret-fixture"}), Duration::from_secs(3), TaskKind::Mutation).unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if instance.task_snapshot(&id).unwrap().status == TaskStatus::Unknown { break; }
        assert!(Instant::now() < until, "child exit did not settle");
        std::thread::sleep(Duration::from_millis(10));
    }
    let ledger = OperationLedger::open(temp.path()).unwrap();
    assert_eq!(ledger.list_pending().unwrap().len(), 1);
    assert_eq!(std::fs::read_to_string(temp.path().join("effect-marker")).unwrap(), "effect\neffect\n");
    let record = std::fs::read_to_string(std::fs::read_dir(temp.path().join("pi-web/management-operations")).unwrap().next().unwrap().unwrap().path()).unwrap();
    assert!(!record.contains("secret-fixture"));
    let restarted = ManagementHost::new();
    let config = fixture(&temp, "ok");
    let instance = restarted.instance("global", &config).unwrap();
    assert!(instance.start_task("auth.logout", serde_json::json!({}), Duration::from_secs(1), TaskKind::Mutation).is_err());
    assert!(instance.start_task("unclassified.op", serde_json::json!({}), Duration::from_secs(1), TaskKind::Mutation).is_err());
    assert_eq!(std::fs::read_to_string(temp.path().join("effect-marker")).unwrap(), "effect\neffect\n", "no child effect after denied admission");
    restarted.shutdown_all(Duration::from_secs(1));
}
