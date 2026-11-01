//! Read-only checks on recorded recovery evidence. A match is not proof that a
//! writer exited, nor permission to publish, roll back, repair, or clear it.
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FencePairEvidence { Matched { operation_id: String }, Invalid }

/// Compare the two already-read records of one fork or continue operation.
/// Callers must independently bind each read to its host-derived fence path.
/// This check deliberately does not read source/target/staging or clear files.
pub fn compare_session_fence_pair(source_bytes: &[u8], target_bytes: &[u8], source_id: &str, target_id: &str) -> FencePairEvidence {
    if source_id.is_empty() || target_id.is_empty() || source_id == target_id || source_bytes.len() > 65536 || target_bytes.len() > 65536 {
        return FencePairEvidence::Invalid;
    }
    let (Ok(source), Ok(target)) = (serde_json::from_slice::<Value>(source_bytes), serde_json::from_slice::<Value>(target_bytes)) else { return FencePairEvidence::Invalid };
    let Some(operation_id) = source.get("operationId").and_then(Value::as_str).filter(|id| !id.is_empty()) else { return FencePairEvidence::Invalid };
    let operation = source.get("operation").and_then(Value::as_str);
    let expected = match operation {
        Some("fork-source") => "fork-target",
        Some("continue") => "continue-target",
        _ => return FencePairEvidence::Invalid,
    };
    let Some(identity) = source.get("source").and_then(Value::as_object) else { return FencePairEvidence::Invalid };
    let valid_digest = identity.get("sha256").and_then(Value::as_str)
        .is_some_and(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    #[cfg(unix)]
    if identity.get("device").and_then(Value::as_u64).is_none() || identity.get("inode").and_then(Value::as_u64).is_none() {
        return FencePairEvidence::Invalid;
    }
    if source.get("version").and_then(Value::as_u64) != Some(1)
        || target.get("version").and_then(Value::as_u64) != Some(1)
        || source.get("sessionId").and_then(Value::as_str) != Some(source_id)
        || target.get("sessionId").and_then(Value::as_str) != Some(target_id)
        || source.get("targetId").and_then(Value::as_str) != Some(target_id)
        || target.get("operation").and_then(Value::as_str) != Some(expected)
        || !identity.get("path").and_then(Value::as_str).is_some_and(|path| !path.is_empty())
        || identity.get("size").and_then(Value::as_u64).is_none() || !valid_digest
        || !source.get("target").and_then(Value::as_str).is_some_and(|path| !path.is_empty())
        || (operation == Some("fork-source") && !source.get("staging").and_then(Value::as_str).is_some_and(|path| !path.is_empty()))
        || (operation == Some("continue") && source.get("staging") != Some(&Value::Null))
        || ["operationId", "source", "target", "targetId", "staging"].iter().any(|key| source.get(*key).is_none() || source.get(*key) != target.get(*key)) {
        return FencePairEvidence::Invalid;
    }
    FencePairEvidence::Matched { operation_id: operation_id.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pair() -> (Value, Value) {
        let source = json!({"version":1,"operationId":"op","sessionId":"s","operation":"fork-source","source":{"path":"/sessions/source","sha256":"a".repeat(64),"size":3,"device":1,"inode":2},"target":"/sessions","targetId":"t","staging":"/staging/op"});
        let mut target = source.clone(); target["sessionId"] = json!("t"); target["operation"] = json!("fork-target");
        (source, target)
    }
    fn check(a: &Value, b: &Value) -> FencePairEvidence {
        compare_session_fence_pair(&serde_json::to_vec(a).unwrap(), &serde_json::to_vec(b).unwrap(), "s", "t")
    }
    #[test]
    fn matching_records_are_evidence_not_authority() {
        let (source, target) = pair();
        assert_eq!(check(&source, &target), FencePairEvidence::Matched { operation_id: "op".into() });
    }
    #[test]
    fn mismatch_partial_and_wrong_operation_are_refused() {
        let (source, target) = pair();
        for key in ["operationId", "source", "target", "targetId", "staging"] {
            let mut altered = target.clone(); altered[key] = json!("different");
            assert_eq!(check(&source, &altered), FencePairEvidence::Invalid, "{key}");
        }
        let mut wrong = target.clone(); wrong["operation"] = json!("continue-target");
        assert_eq!(check(&source, &wrong), FencePairEvidence::Invalid);
        assert_eq!(compare_session_fence_pair(b"{", b"{}", "s", "t"), FencePairEvidence::Invalid);
        assert_eq!(compare_session_fence_pair(&vec![b' '; 65537], b"{}", "s", "t"), FencePairEvidence::Invalid);
    }
    #[test]
    fn continue_pair_requires_null_staging() {
        let (mut source, mut target) = pair();
        source["operation"] = json!("continue"); target["operation"] = json!("continue-target");
        source["staging"] = Value::Null; target["staging"] = Value::Null;
        assert!(matches!(check(&source, &target), FencePairEvidence::Matched { .. }));
        source["staging"] = json!("/staging"); target["staging"] = json!("/staging");
        assert_eq!(check(&source, &target), FencePairEvidence::Invalid);
    }
}
