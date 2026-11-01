//! Host-submitted prompt receipts. Untagged pi events are observations, not
//! proof that a particular submission completed.
use std::collections::BTreeMap;
use serde_json::Value;
use pi_host::{ErrorKind, PiRpcError};

#[derive(Default)]
pub(crate) struct PromptLifecycle {
    next: u64,
    records: BTreeMap<u64, Receipt>,
    overflow: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptReceiptPhase {
    Submitting, AcknowledgedQueued, AcknowledgedStarted,
    ChildRefusalSideEffectsUnconfirmed, SubmissionOutcomeUnknown,
}
impl PromptReceiptPhase {
    fn description(self) -> &'static str {
        match self {
            Self::Submitting => "submitting", Self::AcknowledgedQueued => "acknowledged queued",
            Self::AcknowledgedStarted => "acknowledged started",
            Self::ChildRefusalSideEffectsUnconfirmed => "child refusal; side effects unconfirmed",
            Self::SubmissionOutcomeUnknown => "submission outcome unknown",
        }
    }
}
struct Receipt { phase: PromptReceiptPhase, start_seen: bool, terminal_seen: bool }

impl PromptLifecycle {
    pub(crate) fn begin(&mut self) -> Option<u64> {
        if self.records.len() >= 128 || self.next == u64::MAX {
            self.overflow = true;
            return None;
        }
        self.next += 1;
        self.records.insert(self.next, Receipt { phase: PromptReceiptPhase::Submitting, start_seen: false, terminal_seen: false });
        Some(self.next)
    }
    pub(crate) fn response(&mut self, id: Option<u64>, command: &str, result: &Result<Value, PiRpcError>) {
        let Some(id) = id else { return };
        let Some(receipt) = self.records.get_mut(&id) else { return };
        match result {
            // A handled command confirms the synchronous RPC handler returned;
            // it says nothing about any background work an extension spawned.
            Ok(value) if command == "prompt" && value.get("disposition").and_then(Value::as_str) == Some("handled") => { self.records.remove(&id); }
            Ok(value) => receipt.phase = match value.get("disposition").and_then(Value::as_str) {
                Some("queued") => PromptReceiptPhase::AcknowledgedQueued,
                _ if command != "prompt" => PromptReceiptPhase::AcknowledgedQueued,
                _ => PromptReceiptPhase::AcknowledgedStarted,
            },
            Err(error) if error.kind == ErrorKind::Invalid => { self.records.remove(&id); }
            Err(error) if error.kind == ErrorKind::Command => receipt.phase = PromptReceiptPhase::ChildRefusalSideEffectsUnconfirmed,
            Err(_) => receipt.phase = PromptReceiptPhase::SubmissionOutcomeUnknown,
        }
    }
    pub(crate) fn observe(&mut self, record: &Value) {
        match record.get("type").and_then(Value::as_str) {
            Some("agent_start") => for receipt in self.records.values_mut() { receipt.start_seen = true; },
            Some("agent_settled") => for receipt in self.records.values_mut() { receipt.terminal_seen = true; },
            _ => {},
        }
    }
    pub(crate) fn diagnostics(&self, session_id: &str) -> Vec<crate::SessionShutdownDiagnostic> {
        use crate::{SessionShutdownDiagnostic as Diagnostic, ShutdownScope, ShutdownScopeReason};
        let mut result: Vec<_> = self.records.iter().map(|(&receipt_id, receipt)| Diagnostic::PromptReceipt {
            session_id: session_id.to_owned(), receipt_id, phase: receipt.phase,
            uncorrelated_start_seen: receipt.start_seen, uncorrelated_terminal_seen: receipt.terminal_seen,
        }).collect();
        if self.overflow { result.push(Diagnostic::ScopeUnknown { scope: ShutdownScope::PromptReceipts, session_id: Some(session_id.to_owned()), reason: ShutdownScopeReason::CapacityExceeded }); }
        result
    }
    pub(crate) fn unknown(&self) -> Vec<String> {
        let mut result = Vec::new();
        for (id, receipt) in &self.records {
            result.push(format!("prompt {id}: {}; uncorrelated start={}, terminal={}", receipt.phase.description(), receipt.start_seen, receipt.terminal_seen));
        }
        if self.overflow { result.push("prompt receipt capacity exceeded".into()); }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn started_ack_and_untagged_terminal_never_prove_prompt_outcome() {
        let mut tracker = PromptLifecycle::default();
        let id = tracker.begin();
        tracker.response(id, "prompt", &Ok(json!({"disposition":"started"})));
        tracker.observe(&json!({"type":"agent_start"}));
        tracker.observe(&json!({"type":"agent_settled"}));
        assert!(tracker.unknown()[0].contains("terminal=true"));
        assert!(matches!(&tracker.diagnostics("session")[0], crate::SessionShutdownDiagnostic::PromptReceipt { uncorrelated_terminal_seen: true, phase: PromptReceiptPhase::AcknowledgedStarted, .. }));
    }
    #[test]
    fn handled_or_certain_pre_send_rejection_completes_only_its_receipt() {
        let mut tracker = PromptLifecycle::default();
        let handled = tracker.begin(); let unknown = tracker.begin(); let rejected = tracker.begin();
        tracker.response(handled, "prompt", &Ok(json!({"disposition":"handled"})));
        tracker.response(rejected, "prompt", &Err(PiRpcError::invalid("invalid before send")));
        tracker.response(unknown, "prompt", &Err(PiRpcError::timeout("uncertain")));
        assert_eq!(tracker.unknown().len(), 1);
        assert!(tracker.unknown()[0].contains("outcome unknown"));
    }
}
