//! The tick engine (M4): one pass of the scheduler loop over the store.
//!
//! Per tick (the host runs it every 30 s, also while the UI is closed):
//! - read tasks (the store is the source of truth; unknown fields pass
//!   through untouched);
//! - for each enabled, unpaused task whose slot decision is Fire: claim the
//!   task lease, admit the run (overlap/concurrency), hand it to the
//!   spawner, and advance the watermark (`lastScheduledFor`);
//! - Drop decisions advance the watermark and record a skipped run;
//! - lease staleness makes another host's task claimable only through the
//!   explicit claim path (never silently);
//! - the spawner reports completion asynchronously (`finish_run`), which the
//!   run book turns into the failure-streak/auto-pause decision the store
//!   persists.
//!
//! The engine is deliberately sync and allocation-light: it owns NO
//! threads; the host's timer calls `tick`.

use crate::store::{RunRecord, TaskStore};
use crate::{decide_slot, CronOracle, SlotAction, Task, Trigger};
use serde_json::Value;

/// How the engine starts runs (implemented by the host: create the session,
/// send the prompt with the scheduled-run marker, watch it settle).
pub trait RunSpawner {
    /// Start one run. Returns Err when the run could not start at all (the
    /// engine records a failed run immediately).
    fn spawn_run(&mut self, task: &Task, scheduled_for_ms: i64, trigger: Trigger) -> Result<(), String>;
    /// The spawner's identity for lease claims ("host-<pid>@<boot>").
    fn owner(&self) -> &str;
}

/// One scheduler engine over a store.
pub struct Engine<'a> {
    pub store: TaskStore,
    pub oracle: &'a dyn CronOracle,
    pub run_book: crate::RunBook,
    pub leases: crate::LeaseTable,
    now_ms: i64,
}

/// The tick's summary (diagnostics and tests).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct TickReport {
    pub fired: Vec<(String, Trigger)>,
    pub skipped_overlap: Vec<String>,
    pub dropped: Vec<String>,
    pub concurrency_deferred: Vec<String>,
    pub paused: Vec<(String, String)>,
}

impl<'a> Engine<'a> {
    pub fn new(store: TaskStore, oracle: &'a dyn CronOracle) -> Self {
        Self {
            store,
            oracle,
            run_book: crate::RunBook::default(),
            leases: crate::LeaseTable::default(),
            now_ms: 0,
        }
    }

    /// Run one tick at `now_ms` (epoch ms; the host passes wall time, tests
    /// pass whatever clock they model).
    pub fn tick(&mut self, now_ms: i64, spawner: &mut dyn RunSpawner) -> Result<TickReport, String> {
        self.now_ms = now_ms;
        let mut report = TickReport::default();
        let mut tasks: Vec<(Task, Value)> = self.store.read_tasks()?.into_values().collect();
        let mut changed = false;

        for (task, _raw) in tasks.iter_mut() {
            // A foreign fresh lease means another host is running this task.
            if self.leases.held_by_other(&task.id, spawner.owner(), now_ms) {
                continue;
            }
            match decide_slot(task, now_ms, self.oracle) {
                SlotAction::None => {}
                SlotAction::Fire { trigger, scheduled_for_ms, skipped_slots } => {
                    // Claim the lease, admit the run, advance the watermark.
                    if !self.leases.claim(&task.id, spawner.owner(), now_ms) {
                        continue;
                    }
                    match self.run_book.admit(&task.id, now_ms) {
                        crate::Admission::Started { .. } => {
                            task.since_ms = scheduled_for_ms;
                            changed = true;
                            match spawner.spawn_run(task, scheduled_for_ms, trigger) {
                                Ok(()) => {
                                    report.fired.push((task.id.clone(), trigger));
                                    self.store.append_run(&RunRecord {
                                        run_id: format!("run-{scheduled_for_ms}-{}", task.id),
                                        task_id: task.id.clone(),
                                        trigger: trigger_label(trigger).to_string(),
                                        scheduled_for_ms,
                                        started_at_ms: now_ms,
                                        ended_at_ms: None,
                                        status: "running".into(),
                                        error: None,
                                        session_file: None,
                                    })?;
                                    if skipped_slots > 0 {
                                        self.store.append_run(&RunRecord {
                                            run_id: format!("skip-{scheduled_for_ms}-{}", task.id),
                                            task_id: task.id.clone(),
                                            trigger: "skip".into(),
                                            scheduled_for_ms,
                                            started_at_ms: now_ms,
                                            ended_at_ms: Some(now_ms),
                                            status: "skipped".into(),
                                            error: None,
                                            session_file: None,
                                        })?;
                                    }
                                }
                                Err(error) => {
                                    report.paused.push((task.id.clone(), error.clone()));
                                    if let Some(reason) = self.run_book.finish(&task.id, true, Some(&error)) {
                                        task.auto_paused_reason = Some(reason);
                                        changed = true;
                                    }
                                }
                            }
                        }
                        crate::Admission::OverlapSkipped => {
                            // Overlap consumes the slot: the run in flight
                            // covers this task's next appearance.
                            task.since_ms = scheduled_for_ms;
                            changed = true;
                            report.skipped_overlap.push(task.id.clone());
                        }
                        crate::Admission::ConcurrencyFull => {
                            // Try again next tick: release the lease, do not
                            // advance the watermark.
                            self.leases.release(&task.id, spawner.owner());
                            report.concurrency_deferred.push(task.id.clone());
                        }
                    }
                }
                SlotAction::Drop { scheduled_for_ms, .. } => {
                    task.since_ms = scheduled_for_ms;
                    changed = true;
                    report.dropped.push(task.id.clone());
                }
            }
        }

        if changed {
            self.store.write_tasks(&tasks)?;
        }
        Ok(report)
    }

    /// Record a finished run (the spawner calls this when its session
    /// settles); persists failure streaks and auto-pause through the store.
    pub fn finish_run(&mut self, task_id: &str, failed: bool, error: Option<&str>) -> Result<Option<String>, String> {
        let paused = self.run_book.finish(task_id, failed, error);
        self.leases.release(task_id, "engine");
        if paused.is_some() {
            let mut tasks: Vec<(Task, Value)> = self.store.read_tasks()?.into_values().collect();
            for (task, _) in tasks.iter_mut() {
                if task.id == task_id {
                    task.auto_paused_reason = paused.clone();
                }
            }
            self.store.write_tasks(&tasks)?;
        }
        Ok(paused)
    }
}

fn trigger_label(trigger: Trigger) -> &'static str {
    match trigger {
        Trigger::Schedule => "schedule",
        Trigger::CatchUp => "catch-up",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use super::*;
    use crate::{Schedule, SlotAction};

    struct GridCron;
    impl CronOracle for GridCron {
        fn previous_run(&self, _expr: &str, _tz: &str, now_ms: i64) -> Option<i64> {
            // One slot per 10 minutes.
            Some(now_ms - now_ms.rem_euclid(600_000))
        }
        fn count_slots_between(&self, _expr: &str, _tz: &str, since_ms: i64, until_ms: i64) -> u32 {
            (((until_ms - since_ms) / 600_000).max(0)) as u32
        }
    }

    struct Recorder {
        spawned: Vec<(String, i64)>,
        fail_all: bool,
    }

    impl RunSpawner for Recorder {
        fn spawn_run(&mut self, task: &Task, scheduled_for_ms: i64, _trigger: Trigger) -> Result<(), String> {
            if self.fail_all {
                return Err("spawner exploded".to_string());
            }
            self.spawned.push((task.id.clone(), scheduled_for_ms));
            Ok(())
        }
        fn owner(&self) -> &str {
            "test-host"
        }
    }

    fn task_json(id: &str) -> Value {
        json!({
            "id": id,
            "name": id,
            "prompt": "go",
            "cwd": "/w",
            "schedule": { "kind": "cron", "expr": "*/10 * * * *", "timezone": "UTC" },
            "enabled": true,
            "consecutiveFailures": 0,
        })
    }

    #[test]
    fn a_due_task_fires_once_and_the_watermark_advances() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = TaskStore::new(dir.path());
        store.write_tasks(&[(crate::task_from_json(&task_json("t1")).unwrap(), task_json("t1"))]).unwrap();
        let mut engine = Engine::new(store, &GridCron);
        let mut spawner = Recorder { spawned: vec![], fail_all: false };

        // now = 10m30s: the 10m slot is 30 s old — on time.
        let report = engine.tick(630_000, &mut spawner).unwrap();
        assert_eq!(report.fired.len(), 1);
        assert_eq!(spawner.spawned.len(), 1);
        assert_eq!(spawner.spawned[0].1, 600_000, "the slot, not the tick time");

        // The very next tick (a minute later): the watermark consumed the
        // slot, the next slot (20m) is not due until 20m.
        let report = engine.tick(690_000, &mut spawner).unwrap();
        assert_eq!(report.fired.len(), 0, "no double fire");
        assert_eq!(spawner.spawned.len(), 1);

        // The run settles; 20m30s: the next slot fires.
        engine.finish_run("t1", false, None).unwrap();
        let report = engine.tick(1_230_000, &mut spawner).unwrap();
        assert_eq!(report.fired.len(), 1);
        assert_eq!(spawner.spawned.len(), 2);

        // While the second run stays active, the 30m slot is an overlap
        // skip (the running task consumes it), never a second run.
        let report = engine.tick(1_830_000, &mut spawner).unwrap();
        assert_eq!(report.skipped_overlap, vec!["t1".to_string()]);
        assert_eq!(spawner.spawned.len(), 2);
    }

    #[test]
    fn overlap_consumes_the_slot_without_a_second_run() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = TaskStore::new(dir.path());
        store.write_tasks(&[(crate::task_from_json(&task_json("t1")).unwrap(), task_json("t1"))]).unwrap();
        let mut engine = Engine::new(store, &GridCron);
        let mut spawner = Recorder { spawned: vec![], fail_all: false };
        engine.tick(630_000, &mut spawner).unwrap();
        // The run never finished; 20m30s arrives: overlap skip consumes it.
        let report = engine.tick(1_230_000, &mut spawner).unwrap();
        assert_eq!(report.skipped_overlap, vec!["t1".to_string()]);
        assert_eq!(spawner.spawned.len(), 1, "still one run");
        // A "skipped" record landed in the ledger.
        let runs = engine.store.read_runs("t1");
        assert!(runs.iter().any(|run| run.status == "skipped"));
        // finish the run; the next slot fires again.
        engine.finish_run("t1", false, None).unwrap();
        let report = engine.tick(1_830_000, &mut spawner).unwrap();
        assert_eq!(report.fired.len(), 1);
    }

    #[test]
    fn concurrency_defers_without_advancing_the_watermark() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = TaskStore::new(dir.path());
        let raws = [task_json("a"), task_json("b"), task_json("c")];
        let parsed: Vec<_> = raws
            .iter()
            .map(|raw| (crate::task_from_json(raw).unwrap(), raw.clone()))
            .collect();
        store.write_tasks(&parsed).unwrap();
        let mut engine = Engine::new(store, &GridCron);
        let mut spawner = Recorder { spawned: vec![], fail_all: false };
        let report = engine.tick(630_000, &mut spawner).unwrap();
        assert_eq!(report.fired.len(), 2, "the cap");
        assert_eq!(report.concurrency_deferred, vec!["c".to_string()]);
        // Still full next tick: c defers again, its slot stays intact.
        let report = engine.tick(660_000, &mut spawner).unwrap();
        assert_eq!(report.concurrency_deferred, vec!["c".to_string()]);
        // One run settles: c's deferred slot finally fires.
        engine.finish_run("a", false, None).unwrap();
        let report = engine.tick(690_000, &mut spawner).unwrap();
        assert_eq!(
            report.fired.iter().filter(|(id, _)| id == "c").count(),
            1,
            "c fired after a slot freed: {report:?}"
        );
        assert_eq!(spawner.spawned.iter().filter(|(id, _)| id == "c").count(), 1);
    }

    #[test]
    fn spawner_failures_pause_through_the_streak() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = TaskStore::new(dir.path());
        store.write_tasks(&[(crate::task_from_json(&task_json("t1")).unwrap(), task_json("t1"))]).unwrap();
        let mut engine = Engine::new(store, &GridCron);
        let mut spawner = Recorder { spawned: vec![], fail_all: true };
        // Fail at 5 consecutive slots: paused on the fifth.
        let mut ticks = 0;
        for minute in 0..5u64 {
            let report = engine.tick(630_000 + minute as i64 * 600_000, &mut spawner).unwrap();
            ticks += report.fired.len();
        }
        assert_eq!(ticks, 0, "spawn failures fire nothing");
        let tasks = engine.store.read_tasks().unwrap();
        let (task, _) = &tasks["t1"];
        assert!(task.auto_paused_reason.is_some(), "paused after 5 spawn failures");
        assert_eq!(task.auto_paused_reason.as_deref(), Some("spawner exploded"));
        // A paused task never fires again.
        let mut spawner2 = Recorder { spawned: vec![], fail_all: false };
        let report = engine.tick(630_000 + 5 * 600_000, &mut spawner2).unwrap();
        assert_eq!(report.fired.len(), 0);
    }

    #[test]
    fn the_slot_boundary_is_decided_by_the_oracle_not_the_tick() {
        // Direct decision check: the engine only fires what decide_slot says.
        let task = Task {
            id: "x".into(),
            enabled: true,
            schedule: Schedule::Cron { expr: "* * * * *".into(), timezone: "UTC".into() },
            since_ms: 600_000,
            auto_paused_reason: None,
        };
        assert_eq!(
            decide_slot(&task, 630_000, &GridCron),
            SlotAction::None,
            "the consumed watermark means nothing to do"
        );
    }
}
