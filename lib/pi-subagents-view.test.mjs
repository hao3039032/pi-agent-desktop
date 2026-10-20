import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  MAX_RUN_ROWS,
  MAX_CHILDREN_PER_NODE,
  MAX_RUN_TREE_DEPTH,
  MAX_FIELD_STRING,
  normalizePiSubagentsCapabilities,
  normalizePiSubagentsSnapshot,
  normalizePiSubagentsTranscript,
  boundActionResult,
} = await jiti.import("./pi-subagents-view.ts");

/** The ping data shape pi-subagents 0.79 returns (src/extension/rpc.js pingData). */
function pingData(overrides = {}) {
  return {
    version: 1,
    methods: ["ping", "status", "manage", "spawn", "steer", "interrupt", "stop", "resume", "cost"],
    capabilities: {
      status: true,
      statusProjection: { version: 1, untargeted: "in-memory-when-ready", targeted: "executor" },
      managementActions: ["schedule.list"],
      fleetStatus: { version: 1 },
      asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 },
      asyncSpawn: true,
      steer: true,
      nonRecoveringSteer: true,
      interrupt: true,
      stop: true,
      resume: true,
      cost: { version: 1 },
    },
    ...overrides,
  };
}

/** The asyncSnapshot node shape (src/runs/shared/async-status-projection.js). */
function snapshotPayload(runs, extra = {}) {
  return {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: 1_800_000_000_000,
    caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32768 },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs,
    ...extra,
  };
}

test("capabilities normalize only what the package advertises", () => {
  const capabilities = normalizePiSubagentsCapabilities(pingData());
  assert.equal(capabilities.protocolVersion, 1);
  assert.equal(capabilities.status, true);
  assert.deepEqual(capabilities.fleetStatus, { version: 1 });
  assert.deepEqual(capabilities.asyncStatusSnapshot, { kind: "pi-subagents.async-status-snapshot", version: 1 });
  assert.equal(capabilities.steer, true);
  assert.equal(capabilities.nonRecoveringSteer, true);
  assert.equal(capabilities.stop, true);
  assert.equal(capabilities.interrupt, true);
  assert.equal(capabilities.resume, true);

  // An older package that advertises nothing: every operation reads false.
  const absent = normalizePiSubagentsCapabilities({ version: 1, capabilities: {} });
  assert.equal(absent.status, false);
  assert.equal(absent.steer, false);
  assert.equal(absent.stop, false);
  assert.equal(absent.fleetStatus, undefined);
  assert.equal(absent.asyncStatusSnapshot, undefined);

  // Missing payload entirely.
  assert.equal(normalizePiSubagentsCapabilities(undefined).protocolVersion, null);
});

test("a snapshot projects runs, children and honest states", () => {
  const view = normalizePiSubagentsSnapshot(
    {
      text: "In-memory subagent status: 2 active children.",
      fleet: { version: 1, entries: [], totalActive: 2, topLevelAsyncCapacity: { used: 1, limit: 4 }, omitted: 0 },
      asyncSnapshot: snapshotPayload([
        {
          id: "run-aaa",
          kind: "subagent",
          label: "reviewer",
          state: "running",
          startedAt: 100,
          updatedAt: 200,
          activity: { currentTool: "read", lastActivityAt: 200, turnCount: 3 },
          model: "zenmux/claude-sonnet-4-6",
        },
        {
          id: "run-bbb",
          kind: "workflow",
          label: "sweep",
          state: "complete",
          startedAt: 50,
          updatedAt: 90,
          endedAt: 90,
          children: [
            { id: "lane-a", kind: "step", label: "review", state: "complete", startedAt: 55, endedAt: 60 },
            { id: "lane-b", kind: "step", label: "check", state: "running", startedAt: 61, activity: { currentTool: "bash" } },
          ],
        },
      ]),
    },
    pingData(),
    { fallbackGeneratedAt: 1 },
  );

  assert.equal(view.available, true);
  assert.equal(view.generatedAt, 1_800_000_000_000);
  assert.equal(view.activeCount, 2);
  assert.equal(view.fleetTotalActive, 2);
  assert.equal(view.summaryText, "In-memory subagent status: 2 active children.");

  const running = view.runs.find((row) => row.runId === "run-aaa");
  assert.equal(running.status, "running");
  assert.equal(running.active, true);
  assert.equal(running.currentTool, "read");
  assert.equal(running.updatedAt, 200);
  assert.equal(running.model, "zenmux/claude-sonnet-4-6");
  assert.deepEqual(running.operations, { stop: true, steer: true, interrupt: true, inspect: true });

  const workflow = view.runs.find((row) => row.runId === "run-bbb");
  assert.equal(workflow.terminal, true);
  // A terminal run cannot be stopped, steered or interrupted, but its transcript
  // is still readable by run id.
  assert.deepEqual(workflow.operations, { stop: false, steer: false, interrupt: false, inspect: true });

  const child = view.runs.find((row) => row.childId === "lane-b");
  assert.equal(child.status, "running");
  assert.equal(child.parentRunId, "run-bbb");
  assert.equal(child.index, 1);
  // A child step is stopped through its childId; steering targets run ids
  // only, because the snapshot carries no authoritative child index.
  assert.deepEqual(child.operations, { stop: true, steer: false, interrupt: false, inspect: false });
  // The fleet summary is projected even when snapshot rows exist: it is the
  // only place foreground work of the current turn appears.
  assert.deepEqual(view.fleetSummary, { totalActive: 2, entries: [], omitted: 0 });

  // Active rows sort before every terminal row; terminal rows keep their own order.
  const firstTerminal = view.runs.findIndex((row) => row.terminal);
  assert.ok(firstTerminal > 0);
  assert.ok(view.runs.slice(0, firstTerminal).every((row) => row.active));
  assert.ok(view.runs.slice(firstTerminal).every((row) => row.terminal));
  const laneA = view.runs.find((row) => row.childId === "lane-a");
  assert.equal(laneA.status, "complete");
  assert.equal(laneA.parentRunId, "run-bbb");
  assert.deepEqual(laneA.operations, { stop: false, steer: false, interrupt: false, inspect: false });
});

test("only a run, or a step child of a known run, is offered stop or inspect", () => {
  const view = normalizePiSubagentsSnapshot(
    {
      asyncSnapshot: snapshotPayload([
        {
          id: "run-root",
          kind: "subagent",
          label: "root",
          state: "running",
          children: [
            // host-step ids are not candidates of the package's own
            // child-identity resolution, so they can never be stopped.
            { id: "host-1", kind: "host-step", label: "host step", state: "running" },
            { id: "lane-1", kind: "step", label: "lane", state: "running" },
          ],
        },
        // A root node of an unknown kind carries an id, but no parent run to
        // address a child-scoped stop through.
        { id: "odd-1", kind: "mystery", label: "odd", state: "running" },
      ]),
    },
    pingData(),
  );

  const hostStep = view.runs.find((row) => row.childId === "host-1");
  assert.equal(hostStep.parentRunId, "run-root");
  assert.equal(hostStep.depth, 1);
  assert.deepEqual(hostStep.operations, { stop: false, steer: false, interrupt: false, inspect: false });

  const step = view.runs.find((row) => row.childId === "lane-1");
  assert.equal(step.parentRunId, "run-root");
  assert.equal(step.depth, 1);
  assert.deepEqual(step.operations, { stop: true, steer: false, interrupt: false, inspect: false });

  const unknownRoot = view.runs.find((row) => row.name === "odd");
  assert.equal(unknownRoot.kind, "unknown");
  assert.equal(unknownRoot.depth, 0);
  assert.equal(unknownRoot.childId, "odd-1");
  assert.equal(unknownRoot.parentRunId, undefined);
  assert.deepEqual(unknownRoot.operations, { stop: false, steer: false, interrupt: false, inspect: false });

  // Inspect is offered exactly where the snapshot reported a run id.
  for (const row of view.runs) assert.equal(row.operations.inspect, row.runId !== undefined);
  assert.equal(view.runs.find((row) => row.runId === "run-root").operations.inspect, true);
});

test("a stop of a nested step is not offered: the package resolves top-level children only", () => {
  // run → step is addressable by childId, but the package's child-scoped stop
  // calls resolveAsyncStatusChild without `includeNested`, so it walks the
  // run's top-level steps only (src/extension/rpc.js, src/runs/shared/
  // child-identity.js). A step below a nested run would answer `not_found`.
  const view = normalizePiSubagentsSnapshot(
    {
      asyncSnapshot: snapshotPayload([
        {
          id: "run-root",
          kind: "subagent",
          label: "root",
          state: "running",
          children: [
            { id: "top-lane", kind: "step", label: "top lane", state: "running" },
            {
              id: "run-nested",
              kind: "subagent",
              label: "nested run",
              state: "running",
              children: [
                { id: "nested-lane", kind: "step", label: "nested lane", state: "running" },
              ],
            },
          ],
        },
      ]),
    },
    pingData(),
  );

  const root = view.runs.find((row) => row.runId === "run-root");
  assert.equal(root.depth, 0);
  assert.deepEqual(root.operations, { stop: true, steer: true, interrupt: true, inspect: true });

  const topLane = view.runs.find((row) => row.childId === "top-lane");
  assert.equal(topLane.depth, 1);
  assert.equal(topLane.parentRunId, "run-root");
  assert.deepEqual(topLane.operations, { stop: true, steer: false, interrupt: false, inspect: false });

  // A nested run is a run node: it is stopped by its own id, depth notwithstanding.
  const nestedRun = view.runs.find((row) => row.runId === "run-nested");
  assert.equal(nestedRun.depth, 1);
  assert.deepEqual(nestedRun.operations, { stop: true, steer: true, interrupt: true, inspect: true });

  const nestedLane = view.runs.find((row) => row.childId === "nested-lane");
  assert.equal(nestedLane.depth, 2);
  assert.equal(nestedLane.parentRunId, "run-nested");
  assert.deepEqual(nestedLane.operations, { stop: false, steer: false, interrupt: false, inspect: false });
});

test("an unknown state stays unknown and is never reported complete", () => {
  const view = normalizePiSubagentsSnapshot(
    {
      asyncSnapshot: snapshotPayload([
        { id: "weird", kind: "subagent", label: "weird", state: "disconnected", startedAt: 5 },
      ]),
    },
    pingData(),
  );
  assert.equal(view.runs[0].status, "unknown");
  assert.equal(view.runs[0].active, false);
  assert.equal(view.runs[0].terminal, false);
  // The row has no ancestor to address a child scoped stop through, so the only
  // operation claimed is the transcript read its run id allows.
  assert.equal(view.runs[0].runId, "weird");
  assert.deepEqual(view.runs[0].operations, { stop: false, steer: false, interrupt: false, inspect: true });
});

test("bounds truncate rows, children and strings from a hostile payload", () => {
  // Wide but shallow: enough children to exceed every budget without an
  // exponential tree (the normalizer must stay fast on hostile input).
  const wide = (count) => Array.from({ length: count }, (_, index) => ({
    id: `child-${index}`,
    kind: "step",
    label: "x".repeat(5_000),
    state: "running",
  }));
  const runs = Array.from({ length: MAX_RUN_ROWS * 3 }, (_, index) => ({
    id: `flood-${index}`,
    kind: "subagent",
    label: `run-${index}`,
    state: "running",
    startedAt: index,
  }));
  const deep = {
    id: "deep-root",
    kind: "workflow",
    label: "deep",
    state: "running",
    children: [{
      id: "deep-1",
      kind: "workflow",
      label: "level-1",
      state: "running",
      children: [{
        id: "deep-2",
        kind: "workflow",
        label: "level-2",
        state: "running",
        children: [{
          id: "deep-3",
          kind: "workflow",
          label: "level-3",
          state: "running",
          // Children beyond MAX_RUN_TREE_DEPTH are dropped and counted.
          children: wide(MAX_CHILDREN_PER_NODE + 4),
        }],
      }],
    }],
  };

  const view = normalizePiSubagentsSnapshot(
    { asyncSnapshot: snapshotPayload([deep, ...runs]) },
    pingData(),
  );

  assert.ok(view.runs.length <= MAX_RUN_ROWS);
  assert.ok(view.omitted.rows >= MAX_RUN_ROWS * 2);
  assert.ok(view.omitted.children > 0);
  for (const row of view.runs) {
    if (row.name.length > MAX_FIELD_STRING) assert.fail(`row name unbounded: ${row.name.length}`);
  }
});

test("the depth budget drops deeper levels and counts the dropped subtrees", () => {
  // A 20-level chain: every level past MAX_RUN_TREE_DEPTH must be absent from
  // the rows, not merely unlikely to be reached.
  let node = { id: "deep-19", kind: "workflow", label: "level-19", state: "running" };
  for (let depth = 18; depth >= 0; depth -= 1) {
    node = { id: `deep-${depth}`, kind: "workflow", label: `level-${depth}`, state: "running", children: [node] };
  }

  const view = normalizePiSubagentsSnapshot(
    { asyncSnapshot: snapshotPayload([node]) },
    pingData(),
  );

  const names = view.runs.map((row) => row.name);
  assert.equal(view.runs.length, MAX_RUN_TREE_DEPTH);
  assert.deepEqual(names.sort(), ["level-0", "level-1", "level-2", "level-3"]);
  assert.ok(!names.includes(`level-${MAX_RUN_TREE_DEPTH}`));
  // The subtree cut at the depth budget is counted, not silently dropped.
  assert.equal(view.omitted.children, 1);
  assert.equal(view.omitted.rows, 0);
});

test("a hostile label is cut to the field budget", () => {
  const view = normalizePiSubagentsSnapshot(
    { asyncSnapshot: snapshotPayload([{ id: "run-long", kind: "subagent", label: "x".repeat(5_000), state: "running" }]) },
    pingData(),
  );
  const row = view.runs.find((candidate) => candidate.runId === "run-long");
  assert.equal(row.name.length, MAX_FIELD_STRING);
});

test("a payload without asyncSnapshot falls back to display-only fleet rows", () => {
  const view = normalizePiSubagentsSnapshot(
    {
      text: "Active runs: 1",
      fleet: {
        version: 1,
        entries: [
          {
            key: "fleet-1",
            agent: "reviewer",
            role: "review",
            model: "zenmux/x",
            effort: "high",
            startedAt: 123,
            tokens: { input: 10, output: 5, total: 15 },
            goal: "Review the diff",
          },
        ],
        totalActive: 1,
        omitted: 0,
      },
    },
    pingData(),
  );
  assert.equal(view.runs.length, 1);
  const row = view.runs[0];
  assert.equal(row.name, "reviewer");
  assert.equal(row.task, "Review the diff");
  assert.equal(row.tokens.total, 15);
  // The fleet DTO exposes no run ids, so no operations may be claimed.
  assert.equal(row.runId, undefined);
  assert.deepEqual(row.operations, { stop: false, steer: false, interrupt: false, inspect: false });
});

test("the fleet summary keeps foreground work visible beside snapshot rows", () => {
  const view = normalizePiSubagentsSnapshot(
    {
      text: "In-memory subagent status: 2 active children.",
      fleet: {
        version: 1,
        entries: [
          // One background lane (already in the snapshot tree) and one
          // foreground child of the running Agent tool (only fleet knows it).
          { key: "fleet-1", agent: "reviewer", startedAt: 100 },
          { key: "fleet-2", agent: "explore", role: "scan", model: "zenmux/x", effort: "low", startedAt: 140, goal: "Scan the tree" },
          { key: "fleet-3", agent: "B".repeat(500), startedAt: 150 },
        ],
        totalActive: 3,
        omitted: 0,
      },
      asyncSnapshot: snapshotPayload([
        { id: "run-aaa", kind: "subagent", label: "reviewer", state: "running", startedAt: 100 },
      ]),
    },
    pingData(),
  );

  assert.equal(view.runs.length, 1);
  assert.equal(view.activeCount, 1);
  assert.equal(view.fleetSummary.totalActive, 3);
  assert.equal(view.fleetSummary.entries.length, 3);
  const foreground = view.fleetSummary.entries[1];
  assert.equal(foreground.agent, "explore");
  assert.equal(foreground.role, "scan");
  assert.equal(foreground.goal, "Scan the tree");
  // Hostile strings inside the summary are bounded like any other field.
  assert.ok(view.fleetSummary.entries[2].agent.length <= MAX_FIELD_STRING);
  // A malformed entry is skipped, not guessed into a row.
  const hostile = normalizePiSubagentsSnapshot(
    { fleet: { version: 1, entries: [{ agent: "x" }, { key: "fleet-2", agent: "ok", startedAt: 1 }], totalActive: 2 } },
    pingData(),
  );
  assert.equal(hostile.fleetSummary.entries.length, 1);
  assert.equal(hostile.fleetSummary.entries[0].key, "fleet-2");
});

test("an empty status payload degrades to an empty available snapshot", () => {
  const view = normalizePiSubagentsSnapshot(undefined, pingData(), { fallbackGeneratedAt: 7 });
  assert.equal(view.available, true);
  assert.equal(view.runs.length, 0);
  assert.equal(view.activeCount, 0);
  assert.equal(view.generatedAt, 7);
  assert.equal(view.summaryText, undefined);
});

test("normalizePiSubagentsTranscript bounds the tail text", () => {
  const text = "l".repeat(200_000);
  const view = normalizePiSubagentsTranscript("run-1", { text }, { lines: 40, index: 2 });
  assert.equal(view.runId, "run-1");
  assert.equal(view.truncated, true);
  assert.equal(view.text.length, 100_000);
  assert.equal(view.lines, 40);
  assert.equal(view.index, 2);

  const small = normalizePiSubagentsTranscript("run-1", { text: "line" }, {});
  assert.equal(small.truncated, false);
  assert.equal(small.lines, 80);

  // A reply without text does not fail; the UI sees empty output.
  assert.equal(normalizePiSubagentsTranscript("run-1", undefined, {}).text, "");
});

test("boundActionResult bounds depth, arrays, keys and strings", () => {
  const cycle = { self: null, long: "y".repeat(1_000) };
  cycle.self = cycle;
  const bounded = boundActionResult(cycle);
  assert.ok(typeof bounded === "object" && bounded !== null);
  // The depth budget turns the cycle into null after MAX_RESULT_DEPTH levels.
  let level = bounded;
  let depth = 0;
  while (level !== null && depth <= 10) {
    level = level.self ?? null;
    depth += 1;
  }
  assert.ok(depth <= 6, `cycle was followed ${depth} levels deep`);
  assert.ok(bounded.long.length <= MAX_FIELD_STRING);

  assert.deepEqual(
    boundActionResult({ list: Array.from({ length: 100 }, (_, index) => index) }).list.length,
    32,
  );
  assert.equal(boundActionResult(Number.NaN), null);
  assert.equal(boundActionResult("plain"), "plain");
  assert.deepEqual(boundActionResult(undefined), null);
});
