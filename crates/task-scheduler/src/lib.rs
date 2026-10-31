//! # task-scheduler — the Rust scheduled-task engine (M4)
//!
//! Semantics frozen from the TS engine (docs/agents/scheduled-tasks.md and
//! lib/scheduled-tasks/*):
//!
//! - a 30 s tick (a task may start up to 30 s late);
//! - slot decisions: within the 2-minute on-time grace → fire; within the
//!   7-day catch-up window → ONE catch-up fire; older → drop (the skipped
//!   count is carried); overlap while the task's run is active → skip;
//! - at most 2 concurrent runs; a task's minimum interval is 5 minutes
//!   (LLM cost guard);
//! - 5 consecutive failures auto-pause (the pausing error is kept for the
//!   UI sentence); any success resets the streak;
//! - a run lease is stale after 90 s without heartbeat; another host may
//!   take over (the takeover is explicit, never a silent double-claim);
//! - cron slot math stays with the management extension's fixed-version
//!   croner (plan §三): this crate consumes a [`CronOracle`].

pub mod engine;
pub mod lease;
pub mod store;
pub mod transaction_lock;
pub use engine::{Engine, RunSpawner, TickReport};
pub use store::{RunRecord, TaskStore};

use std::collections::HashMap;
use serde_json::Value;

/// Shortest allowed gap between two runs of one cron task (LLM cost guard).
pub const MIN_INTERVAL_MS: u64 = 5 * 60_000;
/// A task that fails this many runs in a row is paused.
pub const MAX_CONSECUTIVE_FAILURES: u32 = 5;
/// Scheduled and catch-up runs started at once; manual runs are not capped.
pub const MAX_CONCURRENT_RUNS: usize = 2;
/// A slot this recent still counts as on time rather than a catch-up.
pub const ON_TIME_GRACE_MS: u64 = 2 * 60_000;
/// Slots older than this are dropped instead of caught up.
pub const CATCH_UP_WINDOW_MS: u64 = 7 * 24 * 60 * 60_000;
/// A lease without heartbeat for this long is stale.
pub const LEASE_STALE_MS: u64 = 90_000;
/// The scheduler tick.
pub const DEFAULT_TICK_MS: u64 = 30_000;

/// One task's schedule.
#[derive(Debug, Clone, PartialEq)]
pub enum Schedule {
    Manual,
    Once { at_ms: i64 },
    Cron { expr: String, timezone: String },
}

/// One task (the scheduling-relevant subset; the prompt/cwd travel with the
/// host's store).
#[derive(Debug, Clone)]
pub struct Task {
    pub id: String,
    pub enabled: bool,
    pub schedule: Schedule,
    /// The run-slot watermark: the last slot this task consumed (started,
    /// skipped or dropped), in epoch ms.
    pub since_ms: i64,
    /// Set when consecutive failures paused the task (the pausing error).
    pub auto_paused_reason: Option<String>,
}

/// What the tick decided for a task's slot.
#[derive(Debug, Clone, PartialEq)]
pub enum SlotAction {
    /// Nothing to do (no slot, not due, disabled, paused, or still active).
    None,
    /// Start a run now.
    Fire { trigger: Trigger, scheduled_for_ms: i64, skipped_slots: u32 },
    /// The slot is too old: record it consumed, start nothing.
    Drop { scheduled_for_ms: i64, skipped_slots: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Schedule,
    CatchUp,
}

/// Cron math lives in the management extension (fixed-version croner);
/// the scheduler consumes it through this oracle.
pub trait CronOracle {
    /// The most recent slot strictly before `now_ms`, if any.
    fn previous_run(&self, expr: &str, timezone: &str, now_ms: i64) -> Option<i64>;
    /// How many slots fall in `(since_ms, until_ms]`.
    fn count_slots_between(&self, expr: &str, timezone: &str, since_ms: i64, until_ms: i64) -> u32;
}

/// A no-cron oracle (manual/once schedules never consult it).
pub struct NoCron;
impl CronOracle for NoCron {
    fn previous_run(&self, _expr: &str, _timezone: &str, _now_ms: i64) -> Option<i64> {
        None
    }
    fn count_slots_between(&self, _expr: &str, _timezone: &str, _since_ms: i64, _until_ms: i64) -> u32 {
        0
    }
}

/// The slot decision (lib/scheduled-tasks/catch-up.ts decideSlot).
pub fn decide_slot(
    task: &Task,
    now_ms: i64,
    oracle: &dyn CronOracle,
) -> SlotAction {
    if !task.enabled || task.auto_paused_reason.is_some() {
        return SlotAction::None;
    }
    let (due_ms, skipped) = match &task.schedule {
        Schedule::Manual => return SlotAction::None,
        Schedule::Once { at_ms } => {
            if *at_ms > now_ms {
                return SlotAction::None;
            }
            (*at_ms, 0)
        }
        Schedule::Cron { expr, timezone } => {
            let Some(due) = oracle.previous_run(expr, timezone, now_ms) else {
                return SlotAction::None;
            };
            let skipped = oracle.count_slots_between(expr, timezone, task.since_ms, due);
            (due, skipped)
        }
    };
    if due_ms <= task.since_ms {
        return SlotAction::None;
    }
    let age = (now_ms - due_ms) as u64;
    if age <= ON_TIME_GRACE_MS {
        return SlotAction::Fire { trigger: Trigger::Schedule, scheduled_for_ms: due_ms, skipped_slots: skipped };
    }
    if age <= CATCH_UP_WINDOW_MS {
        return SlotAction::Fire { trigger: Trigger::CatchUp, scheduled_for_ms: due_ms, skipped_slots: skipped };
    }
    SlotAction::Drop { scheduled_for_ms: due_ms, skipped_slots: skipped + 1 }
}

/// One active run.
#[derive(Debug, Clone)]
pub struct ActiveRun {
    pub task_id: String,
    pub started_ms: i64,
}

/// The run book: overlap rules, concurrency cap, failure pause.
#[derive(Default)]
pub struct RunBook {
    active: HashMap<String, ActiveRun>,
    failure_streaks: HashMap<String, u32>,
}

/// How a run attempt was admitted.
#[derive(Debug, Clone, PartialEq)]
pub enum Admission {
    Started { active: usize },
    /// The task's previous run is still going: skip the slot.
    OverlapSkipped,
    /// The concurrency cap (2) is reached: try again next tick.
    ConcurrencyFull,
}

impl RunBook {
    /// Admit a run for a task under the overlap/concurrency rules.
    pub fn admit(&mut self, task_id: &str, now_ms: i64) -> Admission {
        if self.active.contains_key(task_id) {
            return Admission::OverlapSkipped;
        }
        if self.active.len() >= MAX_CONCURRENT_RUNS {
            return Admission::ConcurrencyFull;
        }
        self.active.insert(
            task_id.to_string(),
            ActiveRun { task_id: task_id.to_string(), started_ms: now_ms },
        );
        Admission::Started { active: self.active.len() }
    }

    /// A manual "run now" bypasses the cap (the TS rule) but not overlap.
    pub fn admit_manual(&mut self, task_id: &str, now_ms: i64) -> Admission {
        if self.active.contains_key(task_id) {
            return Admission::OverlapSkipped;
        }
        self.active.insert(
            task_id.to_string(),
            ActiveRun { task_id: task_id.to_string(), started_ms: now_ms },
        );
        Admission::Started { active: self.active.len() }
    }

    /// Record a finished run; returns Some(reason) when the task must be
    /// auto-paused now (the pausing error for the UI).
    pub fn finish(&mut self, task_id: &str, failed: bool, error: Option<&str>) -> Option<String> {
        self.active.remove(task_id);
        if !failed {
            self.failure_streaks.remove(task_id);
            return None;
        }
        let streak = self.failure_streaks.entry(task_id.to_string()).or_insert(0);
        *streak += 1;
        if *streak >= MAX_CONSECUTIVE_FAILURES {
            self.failure_streaks.remove(task_id);
            return Some(error.unwrap_or("the run failed").to_string());
        }
        None
    }

    /// Whether a task's run is active (overlap checks).
    pub fn is_active(&self, task_id: &str) -> bool {
        self.active.contains_key(task_id)
    }

    /// How many runs are active.
    pub fn active_count(&self) -> usize {
        self.active.len()
    }

    /// Drop runs older than a max duration (host-enforced kill).
    pub fn reap_expired(&mut self, now_ms: i64, max_duration_ms: i64) -> Vec<String> {
        let expired: Vec<String> = self
            .active
            .iter()
            .filter(|(_, run)| now_ms - run.started_ms > max_duration_ms)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &expired {
            self.active.remove(id);
        }
        expired
    }
}

/// One task lease (multi-process claim).
#[derive(Debug, Clone)]
pub struct Lease {
    pub owner: String,
    pub heartbeat_ms: i64,
}

/// The lease table: claims, heartbeats, staleness, explicit takeover.
#[derive(Default)]
pub struct LeaseTable {
    leases: HashMap<String, Lease>,
}

impl LeaseTable {
    /// A stale lease (90 s without heartbeat) is claimable by anyone;
    /// a fresh one only by its owner.
    pub fn claim(&mut self, task_id: &str, owner: &str, now_ms: i64) -> bool {
        match self.leases.get(task_id) {
            Some(lease) => {
                let stale = now_ms.saturating_sub(lease.heartbeat_ms) as u64 > LEASE_STALE_MS;
                if stale || lease.owner == owner {
                    self.leases.insert(
                        task_id.to_string(),
                        Lease { owner: owner.to_string(), heartbeat_ms: now_ms },
                    );
                    true
                } else {
                    false
                }
            }
            None => {
                self.leases.insert(
                    task_id.to_string(),
                    Lease { owner: owner.to_string(), heartbeat_ms: now_ms },
                );
                true
            }
        }
    }

    /// Refresh (only the owner may).
    pub fn heartbeat(&mut self, task_id: &str, owner: &str, now_ms: i64) -> bool {
        match self.leases.get_mut(task_id) {
            Some(lease) if lease.owner == owner => {
                lease.heartbeat_ms = now_ms;
                true
            }
            _ => false,
        }
    }

    /// Release (only the owner may).
    pub fn release(&mut self, task_id: &str, owner: &str) -> bool {
        match self.leases.get(task_id) {
            Some(lease) if lease.owner == owner => {
                self.leases.remove(task_id);
                true
            }
            _ => false,
        }
    }

    /// Whether a foreign fresh lease holds the task.
    pub fn held_by_other(&self, task_id: &str, owner: &str, now_ms: i64) -> bool {
        match self.leases.get(task_id) {
            Some(lease) => {
                lease.owner != owner && (now_ms.saturating_sub(lease.heartbeat_ms) as u64) <= LEASE_STALE_MS
            }
            None => false,
        }
    }
}

/// Parse a task from the on-disk JSON shape (bridge to the store).
pub fn task_from_json(value: &Value) -> Option<Task> {
    let id = value.get("id").and_then(Value::as_str)?.to_string();
    let enabled = value.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let since_ms = value
        .get("lastSlotMs")
        .and_then(Value::as_i64)
        .or_else(|| value.get("sinceMs").and_then(Value::as_i64))
        .unwrap_or(0);
    let auto_paused_reason = value
        .get("autoPausedReason")
        .and_then(Value::as_str)
        .map(str::to_string);
    let schedule = match value.get("schedule").and_then(|s| s.get("kind")).and_then(Value::as_str) {
        Some("manual") => Schedule::Manual,
        Some("once") => Schedule::Once {
            // The disk shape stores an ISO timestamp (`schedule.at`); an
            // epoch-ms number is accepted from in-memory callers for
            // convenience (store.rs owns the disk mapping).
            at_ms: value
                .pointer("/schedule/at")
                .and_then(Value::as_str)
                .and_then(|at| at.parse::<i64>().ok().or_else(|| crate::store::iso_to_ms_pub(at)))
                .or_else(|| value.pointer("/schedule/atMs").and_then(Value::as_i64))
                .unwrap_or(0),
        },
        Some("cron") => Schedule::Cron {
            expr: value.pointer("/schedule/expr").and_then(Value::as_str)?.to_string(),
            timezone: value
                .pointer("/schedule/timezone")
                .and_then(Value::as_str)
                .unwrap_or("UTC")
                .to_string(),
        },
        _ => return None,
    };
    Some(Task { id, enabled, schedule, since_ms, auto_paused_reason })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic oracle over a fixed grid of slots (1 slot per hour).
    struct GridCron {
        slots: Vec<i64>,
    }

    impl CronOracle for GridCron {
        fn previous_run(&self, _expr: &str, _tz: &str, now_ms: i64) -> Option<i64> {
            self.slots.iter().copied().filter(|slot| *slot < now_ms).max()
        }
        fn count_slots_between(&self, _expr: &str, _tz: &str, since_ms: i64, until_ms: i64) -> u32 {
            self.slots.iter().filter(|slot| **slot > since_ms && **slot <= until_ms).count() as u32
        }
    }

    const HOUR: i64 = 3_600_000;
    const MINUTE: i64 = 60_000;

    fn grid() -> GridCron {
        GridCron { slots: (0..24).map(|i| i * HOUR).collect() }
    }

    #[test]
    fn manual_and_disabled_tasks_never_fire() {
        let oracle = NoCron;
        let manual = || Task {
            id: "t".to_string(),
            enabled: true,
            schedule: Schedule::Manual,
            since_ms: 0,
            auto_paused_reason: None,
        };
        assert_eq!(decide_slot(&manual(), 10_000, &oracle), SlotAction::None);
        let paused = Task { auto_paused_reason: Some("boom".into()), ..manual() };
        assert_eq!(decide_slot(&paused, 10_000, &oracle), SlotAction::None);
        let disabled = Task { enabled: false, ..manual() };
        assert_eq!(decide_slot(&disabled, 10_000, &oracle), SlotAction::None);
    }

    #[test]
    fn on_time_grace_fires_schedule() {
        let task = Task {
            id: "t".into(),
            enabled: true,
            schedule: Schedule::Cron { expr: "* * * * *".into(), timezone: "UTC".into() },
            since_ms: 0,
            auto_paused_reason: None,
        };
        // Now = 5h + 1min: the 5h slot is 1 minute old — on time.
        let now = 5 * HOUR + MINUTE;
        assert_eq!(
            decide_slot(&task, now, &grid()),
            SlotAction::Fire { trigger: Trigger::Schedule, scheduled_for_ms: 5 * HOUR, skipped_slots: 5 }
        );
        // Now = 5h + 3min: beyond grace but young — catch-up.
        let now = 5 * HOUR + 3 * MINUTE;
        assert_eq!(
            decide_slot(&task, now, &grid()),
            SlotAction::Fire { trigger: Trigger::CatchUp, scheduled_for_ms: 5 * HOUR, skipped_slots: 5 }
        );
        // The watermark already consumed the slot: nothing.
        let consumed = Task { since_ms: 5 * HOUR, ..task };
        assert_eq!(decide_slot(&consumed, now, &grid()), SlotAction::None);
    }

    #[test]
    fn slots_older_than_seven_days_drop_with_skips() {
        let task = Task {
            id: "t".into(),
            enabled: true,
            schedule: Schedule::Cron { expr: "* * * * *".into(), timezone: "UTC".into() },
            since_ms: 0,
            auto_paused_reason: None,
        };
        // 8 days past the last slot: drop, all 24 slots counted + the drop.
        let now = 24 * HOUR + 8 * 24 * HOUR;
        match decide_slot(&task, now, &grid()) {
            SlotAction::Drop { scheduled_for_ms, skipped_slots } => {
                assert_eq!(scheduled_for_ms, 23 * HOUR);
                assert_eq!(skipped_slots, 24, "23 hourly slots in window + the dropped one");
            }
            other => panic!("expected drop, got {other:?}"),
        }
    }

    #[test]
    fn once_tasks_fire_when_due() {
        let task = Task {
            id: "t".into(),
            enabled: true,
            schedule: Schedule::Once { at_ms: 1_000 },
            since_ms: 0,
            auto_paused_reason: None,
        };
        // 1 s old: within the on-time grace.
        assert_eq!(
            decide_slot(&task, 2_000, &NoCron),
            SlotAction::Fire { trigger: Trigger::Schedule, scheduled_for_ms: 1_000, skipped_slots: 0 }
        );
        let future = Task { schedule: Schedule::Once { at_ms: 10_000 }, ..task };
        assert_eq!(decide_slot(&future, 2_000, &NoCron), SlotAction::None);
    }

    #[test]
    fn concurrency_cap_overlap_and_failure_pause() {
        let mut book = RunBook::default();
        let now = 1_000;
        assert!(matches!(book.admit("a", now), Admission::Started { .. }));
        assert!(matches!(book.admit("b", now), Admission::Started { .. }));
        // Cap reached for scheduled runs.
        assert_eq!(book.admit("c", now), Admission::ConcurrencyFull);
        // Manual runs bypass the cap but not overlap.
        assert!(matches!(book.admit_manual("c", now), Admission::Started { .. }));
        assert_eq!(book.admit_manual("a", now), Admission::OverlapSkipped);

        // Failures: four in a row keep the task running; the fifth pauses
        // it and carries the pausing error. Manual admission keeps the
        // sequence deterministic regardless of the concurrency cap.
        for round in 0..4 {
            assert_eq!(
                book.finish("a", true, Some("boom")),
                None,
                "round {round} must not pause yet"
            );
            assert!(matches!(book.admit_manual("a", now + round + 1), Admission::Started { .. }));
        }
        assert_eq!(
            book.finish("a", true, Some("final boom")),
            Some("final boom".to_string()),
            "the fifth consecutive failure pauses with its error"
        );

        // A success resets the streak: 3 failures, a success, then 4 more
        // failures never reach the pause threshold.
        book.finish("b", false, None); // b's earlier run ends cleanly
        assert!(matches!(book.admit_manual("b", now), Admission::Started { .. }));
        for _ in 0..3 {
            assert_eq!(book.finish("b", true, Some("x")), None);
            book.admit_manual("b", now + 1);
        }
        book.finish("b", false, None);
        book.admit_manual("b", now + 2);
        for _ in 0..4 {
            assert_eq!(book.finish("b", true, Some("y")), None);
            book.admit_manual("b", now + 3);
        }
        // Everything ended: no run is left active.
        book.finish("a", false, None);
        book.finish("b", false, None);
        book.finish("c", false, None);
        assert_eq!(book.active_count(), 0);
    }

    #[test]
    fn leases_heartbeat_staleness_and_takeover() {
        let mut table = LeaseTable::default();
        assert!(table.claim("t", "host-a", 1_000));
        // A fresh foreign lease refuses.
        assert!(!table.claim("t", "host-b", 2_000));
        assert!(table.held_by_other("t", "host-b", 2_000));
        // The owner heartbeats; a foreign takeover fails while fresh.
        assert!(table.heartbeat("t", "host-a", 3_000));
        assert!(!table.claim("t", "host-b", 4_000));
        // 90 s without heartbeat: stale, claimable.
        let late = 3_000 + LEASE_STALE_MS as i64 + 1;
        assert!(table.claim("t", "host-b", late));
        // The old owner lost it: heartbeat refuses, release refuses.
        assert!(!table.heartbeat("t", "host-a", late + 1));
        assert!(!table.release("t", "host-a"));
        assert!(table.release("t", "host-b"));
        assert!(!table.held_by_other("t", "host-a", late + 2));
    }

    #[test]
    fn max_duration_reaps_runs() {
        let mut book = RunBook::default();
        book.admit("a", 0);
        let reaped = book.reap_expired(31 * MINUTE, 30 * MINUTE);
        assert_eq!(reaped, vec!["a".to_string()]);
        assert_eq!(book.active_count(), 0);
    }

    #[test]
    fn tasks_parse_from_the_disk_shape() {
        let value: Value = serde_json::json!({
            "id": "t1",
            "enabled": true,
            "lastSlotMs": 123,
            "schedule": { "kind": "cron", "expr": "17 5 * * *", "timezone": "Asia/Shanghai" },
        });
        let task = task_from_json(&value).expect("parses");
        assert_eq!(task.since_ms, 123);
        match task.schedule {
            Schedule::Cron { expr, timezone } => {
                assert_eq!(expr, "17 5 * * *");
                assert_eq!(timezone, "Asia/Shanghai");
            }
            other => panic!("cron expected, got {other:?}"),
        }
        let paused = serde_json::json!({
            "id": "t2",
            "schedule": { "kind": "manual" },
            "autoPausedReason": "kaputt",
        });
        let task = task_from_json(&paused).expect("parses");
        assert_eq!(task.auto_paused_reason.as_deref(), Some("kaputt"));
    }
}
