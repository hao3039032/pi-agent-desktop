import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// The derivation is pure; a window is only needed because draft-store (imported
// for the shared parked key spelling) touches one during hydration.
globalThis.window = undefined;

const {
  deriveSidebarDraftRows,
  EMPTY_SIDEBAR_DRAFTS,
  mergeDraftSyntheticGroups,
  DRAFT_ROW_PREVIEW_MAX_CHARS,
} = await createJiti(import.meta.url, { tsconfigPaths: true })
  .import("./sidebar-draft-rows.ts");

const draft = (value, images = 0) => ({
  value,
  images: Array.from({ length: images }, () => ({ data: "aGVsbG8=", mimeType: "image/png" })),
});

const group = (projectRoot, modified = "2024-01-01T00:00:00Z") => ({
  projectRoot,
  displayName: projectRoot.split("/").pop(),
  sessions: [],
  latestModified: modified,
  unreadIds: new Set(),
  runningIds: new Set(),
  branches: [],
});

const neverChat = () => false;

test("empty inputs produce the empty model", () => {
  const model = deriveSidebarDraftRows({
    parked: [],
    groups: [],
    selectedCwd: null,
    selectedSessionId: null,
    projectRootFor: (cwd) => cwd,
    isChatCwd: neverChat,
  });
  assert.deepEqual(model, { rows: [], rowsByProjectRoot: new Map(), syntheticGroups: [] });
  // Merging nothing keeps the real list by reference.
  const groups = [group("/a")];
  assert.equal(mergeDraftSyntheticGroups(groups, model), groups);
  assert.deepEqual(EMPTY_SIDEBAR_DRAFTS.syntheticGroups, []);
});

test("a parked draft that hits an existing group becomes its top row", () => {
  const model = deriveSidebarDraftRows({
    parked: [{ cwd: "/work/main-repo", draft: draft("hello draft") }],
    groups: [group("/work/main-repo")],
    selectedCwd: "/other",
    selectedSessionId: "session-1",
    projectRootFor: (cwd) => (cwd === "/work/main-repo" ? "/work/main-repo" : cwd),
    isChatCwd: neverChat,
  });
  assert.equal(model.syntheticGroups.length, 0);
  const rows = model.rowsByProjectRoot.get("/work/main-repo");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cwd, "/work/main-repo");
  assert.equal(rows[0].previewText, "hello draft");
  assert.equal(rows[0].parkedKey, "parked-new:/work/main-repo");
  assert.equal(rows[0].isActive, false);
});

test("a parked cwd without a group gets a synthetic group with a basename name", () => {
  const model = deriveSidebarDraftRows({
    parked: [{ cwd: "/home/me/fresh", draft: draft("just parked") }],
    groups: [group("/work/main-repo")],
    selectedCwd: "/work/main-repo",
    selectedSessionId: "session-1",
    projectRootFor: (cwd) => cwd,
    isChatCwd: neverChat,
  });
  assert.equal(model.syntheticGroups.length, 1);
  const [synthetic] = model.syntheticGroups;
  assert.equal(synthetic.projectRoot, "/home/me/fresh");
  assert.equal(synthetic.displayName, "fresh");
  assert.equal(synthetic.isActiveProject, false);
  assert.equal(synthetic.rows.length, 1);
  // The synthetic row is keyed by its root so the group renderer finds it.
  assert.equal(model.rowsByProjectRoot.get("/home/me/fresh").length, 1);
});

test("a worktree parked draft joins the project's group, not its own", () => {
  const model = deriveSidebarDraftRows({
    parked: [{ cwd: "/work/repo-wt2", draft: draft("wt draft") }],
    groups: [group("/work/repo")],
    selectedCwd: null,
    selectedSessionId: null,
    projectRootFor: (cwd) => (cwd === "/work/repo-wt2" ? "/work/repo" : cwd),
    isChatCwd: neverChat,
  });
  assert.equal(model.syntheticGroups.length, 0);
  assert.equal(model.rowsByProjectRoot.get("/work/repo").length, 1);
  assert.equal(model.rows[0].projectRoot, "/work/repo");
});

test("the active new-session row merges with its parked twin without touching it", () => {
  const model = deriveSidebarDraftRows({
    parked: [{ cwd: "/work/main-repo", draft: draft("parked text") }],
    groups: [group("/work/main-repo")],
    selectedCwd: "/work/main-repo",
    selectedSessionId: null,
    projectRootFor: (cwd) => cwd,
    isChatCwd: neverChat,
  });
  const rows = model.rowsByProjectRoot.get("/work/main-repo");
  assert.equal(rows.length, 1, "one merged row, not two");
  assert.equal(rows[0].isActive, true);
  assert.equal(rows[0].previewText, "parked text");
  // The active row offers no discard: the parked copy must survive untouched.
  assert.equal(rows[0].parkedKey, null);
  assert.equal(model.rows.length, 1);
  assert.equal(rows[0].cwd, "/work/main-repo");
});

test("an active cwd without sessions creates the leading synthetic group", () => {
  const model = deriveSidebarDraftRows({
    parked: [],
    groups: [group("/work/old")],
    selectedCwd: "/brand/new",
    selectedSessionId: null,
    projectRootFor: (cwd) => cwd,
    isChatCwd: neverChat,
  });
  const [synthetic] = model.syntheticGroups;
  assert.equal(synthetic.projectRoot, "/brand/new");
  assert.equal(synthetic.isActiveProject, true);
  assert.equal(synthetic.rows[0].isActive, true);
  assert.equal(synthetic.rows[0].previewText, null, "empty active row has no preview");
  assert.equal(synthetic.rows[0].parkedKey, null);
  // The active row sorts first in the flat list.
  assert.equal(model.rows[0].cwd, "/brand/new");
});

test("a selected session suppresses the active row but keeps parked rows", () => {
  const model = deriveSidebarDraftRows({
    parked: [{ cwd: "/work/a", draft: draft("parked") }],
    groups: [group("/work/a")],
    selectedCwd: "/work/a",
    selectedSessionId: "session-1",
    projectRootFor: (cwd) => cwd,
    isChatCwd: neverChat,
  });
  const [row] = model.rowsByProjectRoot.get("/work/a");
  assert.equal(row.isActive, false);
  assert.equal(row.parkedKey, "parked-new:/work/a");
});

test("chat cwds never produce rows or groups", () => {
  const isChatCwd = (cwd) => cwd === "/hidden/chat-root";
  const model = deriveSidebarDraftRows({
    parked: [
      { cwd: "/hidden/chat-root", draft: draft("chat draft") },
      { cwd: "/work/a", draft: draft("project draft") },
    ],
    groups: [],
    selectedCwd: "/hidden/chat-root",
    selectedSessionId: null,
    projectRootFor: (cwd) => (isChatCwd(cwd) ? null : cwd),
    isChatCwd,
  });
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].cwd, "/work/a");
  assert.equal(model.syntheticGroups.length, 1);
  assert.equal(model.syntheticGroups[0].projectRoot, "/work/a");
});

test("rows order: active first, then parked cwds lexicographically", () => {
  const model = deriveSidebarDraftRows({
    parked: [
      { cwd: "/zeta", draft: draft("z") },
      { cwd: "/alpha", draft: draft("a") },
      { cwd: "/mid", draft: draft("m") },
    ],
    groups: [],
    selectedCwd: "/selected",
    selectedSessionId: null,
    projectRootFor: (cwd) => cwd,
    isChatCwd: neverChat,
  });
  assert.deepEqual(model.rows.map((row) => row.cwd), ["/selected", "/alpha", "/mid", "/zeta"]);
});

test("synthetic groups merge into the project list: active first, parked last", () => {
  const model = deriveSidebarDraftRows({
    parked: [
      { cwd: "/parked-b", draft: draft("b") },
      { cwd: "/parked-a", draft: draft("a") },
    ],
    groups: [],
    selectedCwd: "/active-new",
    selectedSessionId: null,
    projectRootFor: (cwd) => cwd,
    isChatCwd: neverChat,
  });
  const merged = mergeDraftSyntheticGroups([group("/real")], model);
  assert.deepEqual(merged.map((entry) => entry.projectRoot), ["/active-new", "/real", "/parked-a", "/parked-b"]);
  assert.deepEqual(merged.map((entry) => entry.sessions), [[], [], [], []]);
  assert.deepEqual(merged[0].branches, []);
});

test("multiple parked cwds of one absent project share one synthetic group", () => {
  const model = deriveSidebarDraftRows({
    parked: [
      { cwd: "/repo", draft: draft("main") },
      { cwd: "/repo-wt", draft: draft("wt") },
    ],
    groups: [],
    selectedCwd: null,
    selectedSessionId: null,
    projectRootFor: () => "/repo-root",
    isChatCwd: neverChat,
  });
  assert.equal(model.syntheticGroups.length, 1);
  assert.equal(model.syntheticGroups[0].rows.length, 2);
  assert.equal(model.rowsByProjectRoot.get("/repo-root").length, 2);
});

test("previews use the first line, trimmed, capped at 60 code points", () => {
  const long = "x".repeat(100);
  const model = deriveSidebarDraftRows({
    parked: [
      { cwd: "/a", draft: draft(`first line\nsecond line`) },
      { cwd: "/b", draft: draft(long) },
      { cwd: "/c", draft: draft(`  spaced  `) },
      { cwd: "/d", draft: draft("", 3) },
      { cwd: "/e", draft: draft(`text with image`, 1) },
    ],
    groups: [],
    selectedCwd: null,
    selectedSessionId: null,
    projectRootFor: (cwd) => cwd,
    isChatCwd: neverChat,
  });
  const byCwd = new Map(model.rows.map((row) => [row.cwd, row]));
  assert.equal(byCwd.get("/a").previewText, "first line");
  assert.equal(byCwd.get("/b").previewText.length, DRAFT_ROW_PREVIEW_MAX_CHARS + 1);
  assert.ok(byCwd.get("/b").previewText.endsWith("…"));
  assert.equal(byCwd.get("/c").previewText, "spaced");
  assert.equal(byCwd.get("/d").previewText, null);
  assert.equal(byCwd.get("/d").imageCount, 3);
  assert.equal(byCwd.get("/e").previewText, "text with image");
  assert.equal(byCwd.get("/e").imageCount, 1);
});

test("preview truncation splits surrogate pairs safely", () => {
  const emoji = "😀".repeat(70);
  const model = deriveSidebarDraftRows({
    parked: [{ cwd: "/emoji", draft: draft(emoji) }],
    groups: [],
    selectedCwd: null,
    selectedSessionId: null,
    projectRootFor: (cwd) => cwd,
    isChatCwd: neverChat,
  });
  assert.equal(Array.from(model.rows[0].previewText).length, DRAFT_ROW_PREVIEW_MAX_CHARS + 1);
});

test("archived project roots hide their draft rows in every view", () => {
  const archivedRoots = new Set(["/archived/proj"]);
  const model = deriveSidebarDraftRows({
    parked: [
      { cwd: "/archived/proj", draft: draft("hidden parked") },
      { cwd: "/fresh/proj", draft: draft("visible parked") },
      // A worktree of the archived project: its row must hide through the
      // archived root it resolves to, not its own cwd.
      { cwd: "/archived/proj-wt", draft: draft("worktree hidden") },
    ],
    groups: [group("/archived/proj"), group("/fresh/proj")],
    selectedCwd: null,
    selectedSessionId: null,
    projectRootFor: (cwd) => (cwd === "/archived/proj-wt" ? "/archived/proj" : cwd),
    isChatCwd: neverChat,
    archivedRoots,
  });
  // Flat rows (timeline view) exclude archived roots…
  assert.deepEqual(model.rows.map((row) => row.cwd), ["/fresh/proj"]);
  // …so do the per-group rows (grouped view)…
  assert.equal(model.rowsByProjectRoot.has("/archived/proj"), false);
  assert.equal(model.rowsByProjectRoot.get("/fresh/proj").length, 1);
  // …and an archived cwd never becomes a synthetic group either.
  assert.deepEqual(model.syntheticGroups.map((entry) => entry.projectRoot), []);

  // The active row of an archived project hides too, matching how the
  // archived project's sessions and group header stay out of the sidebar.
  const withActive = deriveSidebarDraftRows({
    parked: [],
    groups: [],
    selectedCwd: "/archived/proj",
    selectedSessionId: null,
    projectRootFor: (cwd) => cwd,
    isChatCwd: neverChat,
    archivedRoots,
  });
  assert.deepEqual(withActive.rows, []);
  assert.deepEqual(withActive.syntheticGroups, []);
});
