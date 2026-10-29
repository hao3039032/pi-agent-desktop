import { parkedNewSessionDraftKey, type ChatDraft } from "./draft-store";
import { basenameOf, type ProjectGroup } from "./project-group";

/**
 * Pure projection of parked (and active) new-session drafts into sidebar rows.
 *
 * The sidebar owns the rendering; this module owns the placement rules so they
 * can be tested without React:
 *
 *   - every non-chat parked cwd gets exactly one row;
 *   - a row whose `projectRootFor(cwd)` matches an existing group renders as
 *     that group's topmost row, above the session window (it never counts
 *     toward the MAX_VISIBLE_PROJECT_SESSIONS preview cap);
 *   - a cwd without a group gets a synthetic group (key = cwd, basename
 *     display name, no sessions) so a project that only has a draft is still
 *     visible and reachable;
 *   - when no session is selected and the selected cwd is a project cwd, that
 *     cwd gets an additional active row (highlighted, click focuses the
 *     composer). If the same cwd also has a parked draft the rows merge: the
 *     active row wins the slot and shows the parked preview, while the parked
 *     draft itself stays untouched in storage;
 *   - chat cwds never produce rows or groups (chat drafts stay parked but
 *     invisible, per product decision);
 *   - rows whose project root is archived are hidden in every view — the same
 *     hiding an archived project's sessions get. Archiving is a visibility
 *     decision, not a deletion; un-archiving (or the "+" on the project)
 *     brings the row back.
 */

/** Preview text is the draft's first line, capped at this many code points. */
export const DRAFT_ROW_PREVIEW_MAX_CHARS = 60;

export interface SidebarDraftRowModel {
  /** The cwd the draft belongs to. */
  cwd: string;
  /** Project root the row's group is keyed by (from `projectRootFor`). */
  projectRoot: string;
  /** True for the row of the currently active new-session composer. */
  isActive: boolean;
  /** The parked key to clear on discard; null for the active row. */
  parkedKey: string | null;
  /** Truncated first-line preview; null when the draft has no text. */
  previewText: string | null;
  /** Image count for pure-image drafts. */
  imageCount: number;
}

export interface SidebarDraftSyntheticGroup {
  projectRoot: string;
  displayName: string;
  /** True when the group holds the selected cwd's active row. */
  isActiveProject: boolean;
  rows: SidebarDraftRowModel[];
}

export interface SidebarDraftsModel {
  /** All rows in display order: the active row first, then parked cwds sorted. */
  rows: SidebarDraftRowModel[];
  /** Rows to render at the top of an existing project group, by projectRoot. */
  rowsByProjectRoot: Map<string, SidebarDraftRowModel[]>;
  /** Groups for cwds that match no existing group, in display order. */
  syntheticGroups: SidebarDraftSyntheticGroup[];
}

export const EMPTY_SIDEBAR_DRAFTS: SidebarDraftsModel = {
  rows: [],
  rowsByProjectRoot: new Map(),
  syntheticGroups: [],
};

function previewOf(draft: ChatDraft): string | null {
  const firstLine = draft.value.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return null;
  const chars = Array.from(firstLine);
  return chars.length > DRAFT_ROW_PREVIEW_MAX_CHARS
    ? `${chars.slice(0, DRAFT_ROW_PREVIEW_MAX_CHARS).join("")}…`
    : firstLine;
}

export function deriveSidebarDraftRows(input: {
  parked: Array<{ cwd: string; draft: ChatDraft }>;
  groups: ProjectGroup[];
  selectedCwd: string | null;
  selectedSessionId: string | null;
  projectRootFor: (cwd: string | null) => string | null;
  isChatCwd: (cwd: string | null) => boolean;
  /** Project roots the user archived; their draft rows hide everywhere. */
  archivedRoots?: ReadonlySet<string>;
}): SidebarDraftsModel {
  const { parked, groups, selectedCwd, selectedSessionId, projectRootFor, isChatCwd, archivedRoots } = input;
  const activeCwd = selectedSessionId === null && selectedCwd && !isChatCwd(selectedCwd)
    ? selectedCwd
    : null;

  // cwd → merged row. The active row takes over its cwd's slot but never
  // claims the parked draft: `parkedKey` stays null so the row offers no
  // discard action and clearing it cannot touch the parked copy.
  const rowsByCwd = new Map<string, SidebarDraftRowModel>();
  for (const { cwd, draft } of parked) {
    if (!cwd || isChatCwd(cwd)) continue;
    rowsByCwd.set(cwd, {
      cwd,
      projectRoot: cwd,
      isActive: false,
      parkedKey: parkedNewSessionDraftKey(cwd),
      previewText: previewOf(draft),
      imageCount: draft.images.length,
    });
  }
  if (activeCwd) {
    const parkedRow = rowsByCwd.get(activeCwd);
    rowsByCwd.set(activeCwd, {
      cwd: activeCwd,
      projectRoot: activeCwd,
      isActive: true,
      parkedKey: null,
      previewText: parkedRow?.previewText ?? null,
      imageCount: parkedRow?.imageCount ?? 0,
    });
  }

  const knownRoots = new Set(groups.map((group) => group.projectRoot));
  const rowsByProjectRoot = new Map<string, SidebarDraftRowModel[]>();
  const syntheticByRoot = new Map<string, SidebarDraftSyntheticGroup>();
  const orderedCwds = [
    ...(activeCwd && rowsByCwd.has(activeCwd) ? [activeCwd] : []),
    ...[...rowsByCwd.keys()].filter((cwd) => cwd !== activeCwd).sort((a, b) => a.localeCompare(b)),
  ];

  const rows: SidebarDraftRowModel[] = [];
  for (const cwd of orderedCwds) {
    const row = rowsByCwd.get(cwd);
    if (!row) continue;
    const root = projectRootFor(cwd) ?? cwd;
    // Archived projects hide their draft rows like their sessions.
    if (archivedRoots?.has(root)) continue;
    row.projectRoot = root;
    rows.push(row);

    const groupRows = rowsByProjectRoot.get(root) ?? [];
    groupRows.push(row);
    rowsByProjectRoot.set(root, groupRows);

    if (!knownRoots.has(root)) {
      let synthetic = syntheticByRoot.get(root);
      if (!synthetic) {
        synthetic = {
          projectRoot: root,
          displayName: basenameOf(root),
          isActiveProject: false,
          rows: [],
        };
        syntheticByRoot.set(root, synthetic);
      }
      synthetic.rows.push(row);
      synthetic.isActiveProject = synthetic.isActiveProject || row.isActive;
    }
  }

  return {
    rows,
    rowsByProjectRoot,
    syntheticGroups: [...syntheticByRoot.values()],
  };
}

/** Interleave synthetic draft groups with the real ones: the selected empty
 *  project first (a brand-new project must be visible immediately), parked
 *  synthetic groups after every real group (cwd order). */
export function mergeDraftSyntheticGroups(
  groups: ProjectGroup[],
  drafts: SidebarDraftsModel,
): ProjectGroup[] {
  if (drafts.syntheticGroups.length === 0) return groups;
  const toGroup = (synthetic: SidebarDraftSyntheticGroup): ProjectGroup => ({
    projectRoot: synthetic.projectRoot,
    displayName: synthetic.displayName,
    sessions: [],
    latestModified: "",
    unreadIds: new Set<string>(),
    runningIds: new Set<string>(),
    branches: [],
  });
  const active = drafts.syntheticGroups.filter((group) => group.isActiveProject).map(toGroup);
  const parked = drafts.syntheticGroups
    .filter((group) => !group.isActiveProject)
    .sort((a, b) => a.projectRoot.localeCompare(b.projectRoot))
    .map(toGroup);
  return [...active, ...groups, ...parked];
}
