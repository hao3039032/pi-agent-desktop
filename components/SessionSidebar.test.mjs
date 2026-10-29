import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const source = (await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("only Shift+click bypasses session deletion confirmation", () => {
  // Deleting without Shift must always route through the confirmation step.
  // The handler moved inline into the row's menu item, so match the guard
  // itself rather than a named function, and tolerate either brace style.
  assert.match(
    sessionItemSource,
    /if \(e\.shiftKey\)\s*\{?\s*void performDelete\(\);\s*\}?\s*else\s*\{?\s*setConfirmDelete\(true\);/,
  );
});

test("keeps the project-tree sidebar without an inline explorer section", () => {
  // Upstream's resizable sidebar explorer (ed50d88) is deliberately not
  // adopted: this fork renders the file explorer in the right panel and the
  // sidebar as Chats + project lists. The upstream quick-filter stays.
  assert.match(source, /sidebar-search-input/);
  assert.match(source, /sidebar-chats-header/);
  assert.doesNotMatch(source, /data-resize-handle="sidebar-sections"/);
});

test("the sidebar tree supports row-level keyboard navigation", () => {
  assert.match(source, /role="tree"/);
  assert.match(source, /data-sidebar-tree-row/);
  assert.match(source, /case "ArrowDown":[\s\S]*?focusSidebarTreeRow\(current, 1\)/);
  assert.match(source, /case "ArrowUp":[\s\S]*?focusSidebarTreeRow\(current, -1\)/);
  assert.match(source, /case "Home":[\s\S]*?focusSidebarTreeRow\(current, "first"\)/);
  assert.match(source, /case "End":[\s\S]*?focusSidebarTreeRow\(current, "last"\)/);
  assert.match(sessionItemSource, /role="treeitem"/);
  assert.match(sessionItemSource, /aria-selected=\{isSelected\}/);
  assert.match(sessionItemSource, /requestDelete: beginDeleteConfirmation/);
  assert.match(sessionItemSource, /rename: startRename/);
});

test("streams running sessions and reconnects after visibility or network changes", () => {
  assert.match(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisible\)/);
  assert.match(source, /window\.addEventListener\("online", connect\)/);
  assert.match(source, /source\?\.close\(\)/);
});

test("re-adding a removed project clears only its sidebar marker", () => {
  assert.match(source, /const activateProject = useCallback\(\(cwd: string\) =>/);
  assert.match(source, /if \(!previous\.has\(projectRoot\)\) return previous;/);
  assert.match(source, /next\.delete\(projectRoot\);/);
  // The add-project dialog is the only picker left in the sidebar.
  assert.match(source, /onSelectCwd=\{\(cwd\) => \{\s+activateProject\(cwd\);/);
});

test("exposes the polled running-session set to the shell", () => {
  assert.match(source, /onRunningSessionIdsChange\?: \(ids: Set<string>\) => void/);
  assert.match(source, /onRunningSessionIdsChange\?\.\(runningSessionIds\)/);
});

test("exposes the loaded session catalog to the shell", () => {
  assert.match(source, /onSessionsChange\?: \(sessions: SessionInfo\[\]\) => void/);
  assert.match(source, /onSessionsChange\?\.\(allSessions\)/);
});

test("subagent completion stays silent and never becomes unread", () => {
  assert.match(source, /completionNotificationSuppressedSessionIds\?: string\[\]/);
  assert.match(
    source,
    /completedWithNotifications = completedInBackground\.filter\([\s\S]*?!previousSuppressedCompletionSessionIdsRef\.current\.has\(id\)[\s\S]*?!knownSubagentIds\.has\(id\)/,
  );
  assert.match(source, /completedWithNotifications\.forEach\(\(id\) => next\.add\(id\)\)/);
  assert.match(source, /if \(completedWithNotifications\.length > 0\) \{\s*onBackgroundTaskDone\?\.\(\)/);
  assert.match(
    source,
    /filter\(\(session\) => session\.relation\?\.kind !== "subagent"\)[\s\S]*?unreadEligibleIds\.has\(id\)/,
  );
});

test("includes project activity counts in accessible labels", () => {
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{activity\.running\}\)`\}/,
  );
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{activity\.unread\}\)`\}/,
  );
});

test("formats session timestamps with the active locale", () => {
  assert.match(source, /import \{ formatCompactRelativeTime, formatRelativeTime \} from "@\/lib\/i18n\/format"/);
  assert.match(sessionItemSource, /const \{ locale, t \} = useI18n\(\)/);
  assert.match(sessionItemSource, /formatRelativeTime\(session\.modified, locale\)/);
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  assert.match(
    sessionItemSource,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
  );
});

test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(sessionItemSource, /const handleContextMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(
    sessionItemSource,
    /onContextMenu=\{confirmDelete \|\| renaming \? undefined : handleContextMenu\}/,
  );
});

test("lifecycle refreshes bypass the cache while cross-window polling reuses it", () => {
  assert.match(source, /function sessionListUrl\(summary: boolean, force: boolean\)/);
  assert.match(source, /if \(summary\) return "\/api\/sessions\?summary=1"/);
  assert.match(source, /if \(force\) return "\/api\/sessions\?force=1"/);
  assert.match(source, /cache: "no-store"/);
  // First paint uses the cheap summary listing, then hydrates after a delay.
  assert.match(source, /loadSessions\(true, false, true\)/);
  assert.match(source, /setTimeout\(\(\) => \{[\s\S]*?void loadSessions\(false, true\)/);
  assert.match(source, /data\.sessionListVersion !== sessionListVersionRef\.current[\s\S]*?await loadSessions\(\)/);
  assert.doesNotMatch(source, /sessionRefreshDone|sessionRefreshTimerRef|title=\{t\("sidebar\.refresh"\)\}/);
  assert.match(source, /loadSessions\(false, true\);[\s\S]*?onBackgroundTaskDone/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\{!session\.transient && \(\s*<div\s+className="session-item-trailing"/);
});

test("hides subagent rows and aggregates their state into the main session row", () => {
  assert.match(source, /const sessionFamilies = listSessionFamilies\(projectSessions\)/);
  assert.match(source, /familySessions\.some\(\(session\) => session\.id === selectedSessionId\)/);
  assert.match(source, /familySessions\.some\(\(session\) => runningSessionIds\.has\(session\.id\)\)/);
  assert.doesNotMatch(source, /function SessionTreeItem/);
});

test("Chats sit beside Projects and never enter project grouping", () => {
  assert.match(
    source,
    /const chatSessions = filteredSessions[\s\S]*?session\.workspaceKind === "chat" \|\| isChatCwd\(session\.cwd\)[\s\S]*?const projectSessions = filteredSessions\.filter\(/,
  );
  assert.match(source, /const allChatFamilies = listSessionFamilies\(chatSessions\)/);
  assert.match(source, /const sessionFamilies = listSessionFamilies\(projectSessions\)/);
  assert.match(source, /groupByProject\(projectSessions,/);
  assert.match(source, /getRecentProjects\(allSessions\)/);
  assert.match(source, /sidebar-project-tree-header sidebar-chats-header/);
  assert.match(source, /handleNewSession\(chatWorkspaceCwd \?\? undefined, "chat"\)/);
});

test("Chats show five families at a time even when there are no projects", () => {
  assert.match(source, /const MAX_VISIBLE_CHAT_SESSIONS = 5/);
  assert.match(source, /: chatFamilies\.slice\(0, MAX_VISIBLE_CHAT_SESSIONS \* \(chatSessionPages \+ 1\)\)/);
  assert.match(source, /setChatSessionPages\(\(pages\) => pages \+ 1\)/);
  assert.match(source, /!loading && !error && chatFamilies\.length === 0/);
  assert.match(source, /sidebar-chats-empty/);
  // The Chats section renders before the Projects empty state, so it remains
  // available when `activeProjects` is empty. Synthetic draft groups (a
  // project whose only content is an unsent draft) replace the empty state.
  assert.match(
    source,
    /sidebar-chats-header[\s\S]*?\{allProjects\.length === 0 && activeProjects\.length === 0 \? \(/,
  );
});

test("Chats fold like a project and unfold back to the first five", () => {
  // Folding drops the extra pages so the next unfold starts at five again.
  assert.match(source, /const setChatsFolded = \(folded: boolean\) => \{\s*setChatsCollapsed\(folded\);\s*if \(folded\) setChatSessionPages\(0\);/);
  // A search lists every match regardless of the fold.
  assert.match(source, /const chatsFolded = !trimmedSessionQuery && chatsCollapsed/);
  assert.match(source, /\{!chatsFolded && \(\s*<div className="sidebar-project-tree-children sidebar-chats-list">/);
  // The fold and the page count survive a reload.
  assert.match(source, /APP_PREF_KEYS\.collapsedChats/);
  assert.match(source, /APP_PREF_KEYS\.chatSessionPages/);
});

test("the Chats header shows its menu and add buttons only on hover, like Projects", () => {
  const header = source.slice(
    source.indexOf("sidebar-project-tree-header sidebar-chats-header"),
    source.indexOf("{!chatsFolded && ("),
  );
  // Same hover-revealed tools container the Projects header uses.
  assert.match(header, /className="sidebar-project-tree-tools"/);
  assert.match(header, /sidebar-project-tree-menu/);
  assert.match(header, /sidebar-project-tree-add/);
  assert.match(header, /handleNewSession\(chatWorkspaceCwd \?\? undefined, "chat"\)/);
  assert.doesNotMatch(source, /sidebar-chats-add/);
});

test("chats can be pinned and archived, ordered by recency with no date groups", () => {
  // Pinned first, then recency; archived chats leave the list unless a search is running.
  assert.match(source, /orderChatFamilies\(allChatFamilies, pinnedChats\)/);
  assert.match(source, /trimmedSessionQuery\s*\? orderedChatFamilies\s*: orderedChatFamilies\.filter\(\(family\) => !archivedChats\.has\(family\.root\.id\)\)/);
  // Rows already show their own relative time, so the list has no Today / This week headings.
  assert.doesNotMatch(source, /sidebar-chats-group-label|chatsToday|CHAT_GROUP_LABEL_KEYS/);
  // The +5 paging still runs over the whole order.
  assert.match(source, /: chatFamilies\.slice\(0, MAX_VISIBLE_CHAT_SESSIONS \* \(chatSessionPages \+ 1\)\)/);
  // Archived chats stay reachable and recoverable.
  assert.match(source, /sidebar\.showArchivedChats/);
  assert.match(source, /APP_PREF_KEYS\.pinnedChats/);
  assert.match(source, /APP_PREF_KEYS\.archivedChats/);
  // Row menu: only chat rows (depth 0) get the actions, in both the native and DOM menus.
  assert.match(source, /chatActions=\{depth === 0 \? chatActions : undefined\}/);
  assert.match(source, /t\(chatActions\.pinned \? "sidebar\.unpinChat" : "sidebar\.pinChat"\)/);
  assert.match(source, /t\(chatActions\.archived \? "sidebar\.unarchiveChat" : "sidebar\.archiveChat"\)/);
});

test("a chat's row menu can continue it in a project", () => {
  // Chats only: project rows and subagent children are never given the callback.
  assert.match(source, /onContinueInProject=\{setContinueChat\}/);
  assert.match(source, /onContinueInProject=\{depth === 0 \? onContinueInProject : undefined\}/);
  assert.match(source, /t\("sidebar\.continueInProject"\)/);
  assert.match(source, /\/continue-in-project`/);
  // The picker reuses the project picker and never offers the chat workspace itself.
  assert.match(source, /\{continueChat && \(/);
});

test("a chat cwd skips worktree lookup and stays out of project pickers", () => {
  assert.match(source, /if \(!selectedCwd \|\| selectedCwdIsChat\) \{\s*setWorktreeState\(null\)/);
  assert.match(source, /const selectedProjectRoot = selectedProjectObject\?\.kind === "project"/);
  assert.match(source, /selectedCwd=\{selectedCwdProp && !isChatCwd\(selectedCwdProp\) \? selectedCwdProp : null\}/);
  assert.match(source, /if \(isChatCwd\(cwd\)\) return projectSelection\(cwd, cwd, "chat"\)/);
});

test("the project context menu reveals the project in the OS file manager", async () => {
  // Upstream's open-in-file-manager (#907) reaches the fork through the
  // project context menu: the desktop shell reveals natively and the browser
  // goes through /api/open-in-explorer, which the menu only offers after the
  // availability probe answered. A failure stays visible inside the menu.
  assert.match(source, /const revealProjectInFileManager = useCallback/);
  assert.match(source, /isTauriDesktop\(\) \|\| fileManagerAvailability\?\.supported/);
  assert.match(source, /revealItemInDirNative\(root\)/);
  assert.match(source, /fetch\("\/api\/open-in-explorer", \{\s*method: "POST"/);
  assert.match(source, /FILE_MANAGER_ERROR_KEYS\[data\.error \?\? ""\]/);
  // The menu itself is fork-owned (components/ProjectContextMenu.tsx).
  const menuSource = await readFile(new URL("./ProjectContextMenu.tsx", import.meta.url), "utf8");
  assert.match(menuSource, /\{projectRevealError && \(/);
  // The platform-adaptive label (Finder / Explorer / generic).
  assert.match(source, /"sidebar\.openInFinder"/);
  assert.match(source, /"sidebar\.openInExplorer"/);
  assert.match(source, /"sidebar\.openInFileManager"/);
});

test("session rows swap a compact time for the action button in one fixed-width slot", () => {
  // At rest the row shows its last-activity time; hover, keyboard focus,
  // touch and an open menu show the "…" button in the same slot so the title
  // never reflows.
  assert.match(sessionItemSource, /className="session-item-trailing"/);
  assert.match(sessionItemSource, /hovered \|\| treeFocused \|\| touchMode \|\| menuOpen \?/);
  assert.match(sessionItemSource, /formatCompactRelativeTime\(session\.modified, locale\)/);
  // Transient runtime rows have neither actions nor a reliable time.
  assert.match(sessionItemSource, /\{!session\.transient && \(\s*<div\s+className="session-item-trailing"/);
});

test("project header shows a session count and chips only while folded", () => {
  // A folded project hides its rows, so the header carries the count.
  assert.match(source, /\{isCollapsed && \(\s*<span className="sidebar-project-tree-count"[^>]*>\s*\(\{groupTree\.length\}\)/);
  assert.match(source, /\{isCollapsed && \(\s*<span className="sidebar-project-tree-meta">/);
  // The branch moved from the row into its tooltip.
  assert.doesNotMatch(source, /className="sidebar-project-tree-branch"/);
  assert.match(source, /title=\{rowTitle\}/);
});

test("project header keeps its actions hover-only and no separate chevron", async () => {
  const css = (await readFile(new URL("../app/native-theme.css", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  // The folder glyph already shows open / closed; a chevron would repeat it.
  assert.doesNotMatch(source, /sidebar-project-tree-chevron/);
  assert.match(source, /aria-expanded=\{!isCollapsed\}/);
  assert.match(css, /\.sidebar-project-tree-row-actions \{[^}]*opacity: 0;[^}]*pointer-events: none;/);
  assert.match(css, /\.sidebar-project-tree-row\.is-menu-open \.sidebar-project-tree-row-actions/);
  assert.match(css, /@media \(hover: none\) \{[^@]*\.sidebar-project-tree-row-actions \{\s*opacity: 1;/);
});

test("Projects header actions stay hover-only", async () => {
  const css = await readFile(new URL("../app/native-theme.css", import.meta.url), "utf8");
  assert.match(css, /\.sidebar-project-tree-tools \{[^}]*opacity: 0;[^}]*pointer-events: none;/);
  assert.match(css, /\.sidebar-project-tree-header:hover \.sidebar-project-tree-tools,/);
  assert.match(css, /\.sidebar-project-tree-header\.is-menu-open \.sidebar-project-tree-tools,/);
  assert.match(css, /\.sidebar-project-tree-header:focus-within \.sidebar-project-tree-tools \{\s*opacity: 1;\s*pointer-events: auto;/);
  assert.match(css, /@media \(hover: none\) \{[^@]*\.sidebar-project-tree-tools \{\s*opacity: 1;\s*pointer-events: auto;/);
});

test("folded projects persist across reloads", () => {
  assert.match(source, /getPrefJson<unknown>\(APP_PREF_KEYS\.collapsedProjects\)/);
  assert.match(source, /setPrefJson\(APP_PREF_KEYS\.collapsedProjects, \[\.\.\.collapsedProjects\]\)/);
  // Collapse/expand-all operate on the visible project groups.
  assert.match(source, /const canCollapseAllProjects = activeProjects\.some\(\(group\) => !collapsedProjects\.has\(group\.projectRoot\)\)/);
  assert.match(source, /const canExpandAllProjects = activeProjects\.some\(\(group\) => collapsedProjects\.has\(group\.projectRoot\)\)/);
  assert.match(source, /setCollapsedProjects\(new Set\(activeProjectRoots\)\)/);
  assert.match(source, /setCollapsedProjects\(new Set\(\)\)/);
});

test("show more reveals five sessions at a time and a project toggle resets it", () => {
  assert.match(source, /getPrefJson<unknown>\(APP_PREF_KEYS\.expandedProjects\)/);
  assert.match(source, /setPrefJson\(APP_PREF_KEYS\.expandedProjects, projectSessionPages\)/);
  assert.match(source, /const visibleSessionLimit = MAX_VISIBLE_PROJECT_SESSIONS \* \(extraPages \+ 1\)/);
  assert.match(
    source,
    /\[group\.projectRoot\]: \(prev\[group\.projectRoot\] \?\? 0\) \+ 1/,
  );
  assert.match(
    source,
    /count: Math\.min\(MAX_VISIBLE_PROJECT_SESSIONS, hiddenSessionCount\)/,
  );
  // Reopening a project starts from its latest five sessions again.
  assert.match(source, /setProjectSessionPages\(\(prev\) => \{[\s\S]*?delete next\[group\.projectRoot\]/);
  // Legacy arrays meant "expanded everything"; migrate them to one extra page.
  assert.match(source, /Array\.isArray\(stored\)[\s\S]*?\.map\(\(root\) => \[root, 1\]\)/);
});

test("Projects pane chooses between grouped and chronological views", () => {
  // The old Recent section is replaced by a persisted display mode.
  assert.doesNotMatch(source, /recent-sessions|sidebar-recent-section|hasTodaySessions|recentSessions/);
  assert.match(source, /const \[projectViewMode, setProjectViewMode\] = useState<ProjectViewMode>\(loadProjectViewMode\)/);
  assert.match(source, /setPref\(APP_PREF_KEYS\.projectViewMode, mode\)/);
  assert.match(
    source,
    /projectViewMode === "timeline"\s*\? renderTimeline\(\)\s*: activeProjects\.map\(\(group\) => renderProjectGroup\(group\)\)/,
  );
});

test("the chronological view lists session families by activity with project labels", () => {
  assert.match(source, /const timelineFamilies = projectViewMode === "timeline"/);
  assert.match(source, /sessionFamilies\.filter\(\(family\) =>/);
  assert.match(source, /\.sort\(\(a, b\) => b\.root\.modified\.localeCompare\(a\.root\.modified\)\)/);
  assert.match(source, /buildSessionTree\(\[family\.root, \.\.\.family\.subagents\]\)/);
  assert.match(source, /className="sidebar-project-timeline"/);
  assert.match(source, /subtitle=\{projectName\}/);
});

test("the Projects menu keeps grouped/timeline choices and collapse controls", async () => {
  const menuSource = await readFile(new URL("./ProjectViewMenu.tsx", import.meta.url), "utf8");
  assert.match(menuSource, /role="menuitemradio"/);
  assert.match(menuSource, /sidebar\.projectViewGrouped/);
  assert.match(menuSource, /sidebar\.projectViewTimeline/);
  assert.match(menuSource, /sidebar\.collapseAllProjects/);
  assert.match(menuSource, /sidebar\.expandAllProjects/);
  assert.match(source, /canUseNativeMenu\(\)[\s\S]*?showNativeMenu\(entries, menuPointBelow\(anchor, "right"\)\)/);
});

test("the row menu shows the compaction count only when the session was compacted", () => {
  assert.match(
    sessionItemSource,
    /\{\(session\.compactionCount \?\? 0\) > 0 && \(\s*<div>\{t\("sidebar\.compactionCount", \{ count: session\.compactionCount \?\? 0 \}\)\}<\/div>/,
  );
});

test("unsent drafts show as rows in the project tree and stay out of Chats", () => {
  // Parked drafts (and the active new-session composer) are projected by the
  // pure helper; the sidebar only wires its live state into it.
  assert.match(source, /import \{ clearDraft, listParkedNewSessionDrafts, subscribeParkedDrafts \} from "@\/lib\/draft-store";/);
  assert.match(source, /import \{\s*deriveSidebarDraftRows,\s*draftRowProjectRootFor,\s*EMPTY_SIDEBAR_DRAFTS,\s*mergeDraftSyntheticGroups,\s*type SidebarDraftRowModel,\s*\} from "@\/lib\/sidebar-draft-rows";/);
  // Re-renders come from the parked-draft subscription (also cross-window).
  assert.match(source, /subscribeParkedDrafts\(\(\) => bumpParkedDrafts\(\)\)/);
  // Parked rows wait for the first successful session list load: without the
  // server's chat identity a parked chat draft would render as a project
  // group. This also keeps the SSR and client first paint identical.
  assert.match(source, /const parkedNewSessionDrafts = sessionsLoaded \? listParkedNewSessionDrafts\(\) : \[\];/);
  assert.match(source, /setSessionsLoaded\(true\)/);
  // The helper receives the chat filter, so chat cwds never produce rows or
  // synthetic groups, and the archived roots so a parked draft hides exactly
  // where its archived project's sessions hide (grouped and timeline alike).
  assert.match(
    source,
    /deriveSidebarDraftRows\(\{\s*parked: parkedNewSessionDrafts,\s*groups: allProjects,\s*selectedCwd,\s*selectedSessionId,\s*projectRootFor: draftProjectRootFor,\s*isChatCwd,\s*archivedRoots: archivedProjectRoots,\s*\}\)/,
  );
  // Synthetic draft groups join the project list (and thus the composer's
  // project list through onProjectsChange).
  assert.match(source, /const activeProjects = mergeDraftSyntheticGroups\(/);
  // A search lists matches only, so the draft rows hide while one runs.
  assert.match(source, /const sidebarDrafts = trimmedSessionQuery\s*\?\s*EMPTY_SIDEBAR_DRAFTS\s*:/);
});

test("draft rows sit above the session window and ignore the preview cap", () => {
  // The rows render before the windowed session tree inside the group's
  // children, so they never count toward MAX_VISIBLE_PROJECT_SESSIONS.
  const grouped = source.slice(
    source.indexOf("const renderProjectGroup = "),
    source.indexOf("const renderTimeline = "),
  );
  assert.match(
    grouped,
    /sidebarDrafts\.rowsByProjectRoot\.get\(group\.projectRoot\)[\s\S]*?<SidebarDraftRowItem[\s\S]*?\{visibleGroupTree\.map/,
  );
});

test("draft row clicks dispatch by activity and parked rows can be discarded", () => {
  // The active row only focuses the composer; a parked row re-enters its cwd
  // through the same path as the group's "+", which restores the draft.
  assert.match(
    source,
    /const activateDraftRow = \(row: SidebarDraftRowModel\) => \{\s*if \(row\.isActive\) \{\s*onFocusComposer\?\.\(\);\s*return;\s*\}\s*handleNewSession\(row\.cwd, "project"\);\s*\};/,
  );
  assert.match(source, /if \(row\.parkedKey\) clearDraft\(row\.parkedKey\);/);
  assert.match(source, /onFocusComposer\?: \(\) => void;/);
});

test("the chronological view lists draft rows first with project subtitles", () => {
  const timeline = source.slice(source.indexOf("const renderTimeline = "));
  assert.match(timeline, /sidebarDrafts\.rows\.map\(\(row\) => \([\s\S]*?<SidebarDraftRowItem/);
  assert.match(timeline, /subtitle=\{projectDisplayNames\.get\(row\.projectRoot\)/);
  assert.match(timeline, /getProjectDisplayName\(row\.projectRoot, activeProjectRoots\)\}/);
});

test("a parked draft keeps the project root the server reported for its cwd", () => {
  // A worktree without sessions has no session row, and its project's worktree
  // listing is replaced the moment the user switches projects. The row resolver
  // therefore falls back to the roots the server reported for this browser
  // (lib/cwd-project-roots.ts); without it the row became a synthetic project
  // of its own and the archived-project hiding no longer applied.
  assert.match(source, /import \{ rememberCwdProjectRoots, subscribeCwdProjectRoots \} from "@\/lib\/cwd-project-roots";/);
  assert.match(source, /draftRowProjectRootFor,\s*EMPTY_SIDEBAR_DRAFTS,/);
  // Every server answer is recorded (incomplete rows are skipped, never stored
  // as "its own project") together with the selected project's worktree
  // listing.
  assert.match(
    source,
    /rememberCwdProjectRoots\(\s*allSessions\s*\.filter\(\(session\) => session\.workspaceKind !== "chat"\)\s*\.map\(\(session\) => \[session\.cwd, session\.projectRoot\] as const\),\s*\);/,
  );
  assert.match(
    source,
    /rememberCwdProjectRoots\(\[\s*\[worktreeState\.forCwd, worktreeState\.projectRoot\] as const,\s*\.\.\.worktreeState\.worktrees\.map\(\(worktree\) => \[worktree\.path, worktreeState\.projectRoot\] as const\),\s*\]\);/,
  );
  // Draft rows resolve through the remembered root…
  assert.match(
    source,
    /const draftProjectRootFor = useCallback\(\(cwd: string \| null\): string \| null => \{\s*if \(!cwd\) return null;\s*if \(isChatCwd\(cwd\)\) return null;\s*return draftRowProjectRootFor\(serverProjectRootFor\(cwd\), cwd\);/,
  );
  assert.match(source, /projectRootFor: draftProjectRootFor,/);
  // Another window can learn an identity this one never saw; the sidebar has to
  // re-render its parked rows when that arrives, or the row keeps the grouping
  // of its stale map.
  assert.match(source, /useEffect\(\(\) => subscribeCwdProjectRoots\(\(\) => bumpParkedDrafts\(\)\), \[\]\);/);
  // …while project selection keeps its own fallback: an unresolved cwd is
  // still its own workspace, and chat cwds never resolve to a project.
  assert.match(source, /return serverProjectRootFor\(cwd\) \?\? cwd;/);
});

test("an incomplete session row answers no root instead of the cwd", () => {
  // `projectRoot` is optional on SessionInfo, and a partial row must not claim
  // its cwd is a known root: that would stop a draft row from falling back to
  // the identity the server reported earlier, and the row would become a
  // synthetic project of its own (escaping archived-project hiding).
  assert.match(
    source,
    /const match = allSessions\.find\(\(s\) => s\.cwd === cwd\);\s*return match\?\.projectRoot \?\? null;/,
  );
});

test("the shell-known chat cwd classifies the active row before the list loads", async () => {
  // Wiring: AppShell passes its server-resolved chat cwd down, and
  // isChatCwd consults it first — the gap between `?cwd` validation
  // resolving and this sidebar's own /api/sessions response would otherwise
  // synthesize a "chats" project group for the active composer row.
  const shellSource = (await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(shellSource, /knownChatCwd=\{chatWorkspaceCwd\}/);
  assert.match(source, /knownChatCwd\?: string \| null;/);
  assert.match(
    source,
    /if \(knownChatCwd && cwd === knownChatCwd\) return true;\s*if \(chatWorkspaceCwd && cwd === chatWorkspaceCwd\) return true;/,
  );
  // The parked half stays gated on the list load; the active half does not
  // wait for it (a project cwd appears immediately).
  assert.match(source, /const parkedNewSessionDrafts = sessionsLoaded \? listParkedNewSessionDrafts\(\) : \[\];/);

  // Behavioral: run the actual isChatCwd body with an empty session list
  // (the slow/failed list case) — only the shell-known cwd classifies.
  const start = source.indexOf("const isChatCwd = useCallback");
  const end = source.indexOf("const selectedCwdIsChat", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const runWith = (knownChatCwd, chatWorkspaceCwd) => {
    const context = vm.createContext({
      knownChatCwd,
      chatWorkspaceCwd,
      allSessions: [],
      useCallback: (fn) => fn,
    });
    vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
    return vm.runInContext("isChatCwd", context);
  };
  const classify = runWith("/srv/chats/root", null);
  assert.equal(classify("/srv/chats/root"), true, "the shell-known chat cwd is chat");
  assert.equal(classify("/srv/chats/root/sub"), false, "children of the chat root are not guessed");
  assert.equal(classify("/work/project"), false, "a project cwd stays project");
  const withoutShell = runWith(null, null);
  assert.equal(withoutShell("/srv/chats/root"), false, "no identity yet → no guess");
});
