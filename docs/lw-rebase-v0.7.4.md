# LW → abcwyc v0.7.4 integration record

## Identity and history

- Direct upstream: https://github.com/abcwyc/pi-agent-desktop, remote `abcwyc`.
- Old desktop base: `156aedb31affccb1fc876002b51203acfe6741d7` (v0.7.2).
- New desktop base: `2e0e3e714866f1b3772c65b34b51cac530fb5316` (v0.7.4).
- Original LW tip: `6f4ddbed060ee2f2a3e576ca9d810068e09fef52`, retained in `backup/pre-squash-6f4ddbed`.
- Consolidated only the 13 LW commits into five functional layers. Before rebasing, the consolidated tree was verified identical to the original (`d35454f2e77f4a636e4f8849ea88b14cfd1ce21f`). abcwyc history is untouched.
- The local bare `v0.7.4` names agegr/pi-web's release. It is NOT the desktop release. Use the remote-qualified ref, as required by `AGENTS.md`.

## Semantic overlap decisions

1. **Settings:** retain v0.7.4's General layout and its single language selector; insert LW service settings beside the update section. Do not restore the old layout while resolving the insertion.
2. **Attachments / Chats:** preserve the upstream `+` picker and its shared `importProjectFiles` path. Native drops own desktop OS drops; HTML5 exits on desktop. Non-project Chats remain image-only: no inserted directory paths or copied project files, including mixed native drops. Streaming messages retain `openFile` (disabled for Chats), not raw `onOpenFile`.
3. **Images / Artifacts:** images remain outside collapsed process details, without duplicate streaming bubbles. Preserve `editDisabled` from upstream. The retired widget tools, dependencies and pop-out routes are not replayed as intermediate feature commits.
4. **Locales / extracted code:** LW translation additions live in `lib/i18n/locale-plugins.ts`; all three base locale files match abcwyc v0.7.4. Keep upstream's extracted hooks/components and the updated workspace identity behavior.
5. **Subagents:** retain pi-subagents priority, runtime activation guards and inherited security extensions. Update the newly extracted `fork-tools-subagents.md` so it does not instruct a future merge to reverse the precedence.
6. **Distribution:** retain model-preserving defaults, runtime staging, signed update URL handling and stale frontend cache cleanup. Reset distro revision to 1 for the new desktop base (0.7.401 under the existing version formula). No release was published.
7. **Inherited boundaries:** the pi-web ownership/CSS checks remain inherited abcwyc maintenance tools, not LW's rebase baseline. Update the locale overlap guard to follow the extracted patch layer.

## Validation (Windows, existing installed dependencies)

- Dependency-lock check, TypeScript `--noEmit`, lint/branding: passed.
- `npm run drift`: passed after updating locale ownership; this still measures the inherited pi-web boundary.
- `package-lock.json`, `app/globals.css`, `app/settings.css`: unchanged from abcwyc v0.7.4.
- UI/hooks/scripts suite (before the follow-up below): compared with an isolated worktree at exactly abcwyc v0.7.4 using the same node_modules. The upstream baseline failed 110 cases (CRLF-sensitive source assertions and SSR i18n harness failures). No additional failing LW test names remained, and one old composer-alignment failure was resolved. Superseded by the follow-up, which made this suite fully green.
- Focused lib suite (distro, subagents, security inheritance, images, artifacts, locales, rpc, session reader): 390 tests, 386 passed, 3 skipped, 1 failed. The remaining failure is Windows EPERM creating a file symlink in `subagent-input.test.mjs`, reproduced on upstream. Two security-extension integration cases skip because the external packages are not installed.
- LW route tests (distro, native path classification, file imports, subagent settings): 17 tests, 16 passed, 1 skipped, no failures.
- No production build, packaged/native GUI smoke test, or browser E2E was run. No push/force-push was performed.

## Follow-up: Windows test environment repair

The earlier UI failures were resolved without upgrading dependencies: pin LF checkouts in `.gitattributes`, use the same extensionless Jiti import as components for React context/draft-store identity, and invoke npm's JS CLI rather than spawning `npm.cmd`. npm's script globs now use double quotes: on Windows the previous single-quoted command silently reported zero tests (exit code 0 with `1..0`).

A broader server-suite attempt did not complete within the execution deadline. Observed failures include unsupported POSIX chmod expectations (`0600` vs Windows `0666`), file-symlink `EPERM`, and child-process working-directory cleanup `EBUSY`; full-suite green is not claimed. No system privileges, Developer Mode, global packages or credentials were changed. These tests need Linux CI/WSL or separately reviewed Windows harness adaptations, not blanket npm dependency installation.

One more cause was found and is worth knowing before attributing server failures to source: running `npm test` from inside the Pi desktop app shell exports `PI_PACKAGE_DIR`, `PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT` and `JITI_ALIAS`, which make the tests resolve the *installed application's* SDK and packages instead of this checkout. `lib/mcp-host.test.mjs` then reports ~12 failures that vanish when those variables are unset for the test process (`50 passed, 1 skipped`). Nothing in the source needed changing.

## Review loop over this integration

Two rounds of fresh-context review (three reviewers per round, plus one fix worker) ran against the consolidated commits and the uncommitted test-environment repair. Both rounds ended `Merge verdict: OK with notes` with no P0 and no confirmed P1.

Accepted and fixed:

1. Promoted generated images no longer make an expanded tool result print `(no output)` (`components/MessageView.tsx`).
2. Browser and native import paths, plus the composer's image compression, now carry a generation/session guard so a completed read cannot write mentions, attachments or notices into another session — including A→B→A, where comparing a session id alone is not enough (`components/ChatWindow.tsx`, `components/ChatInput.tsx`, `components/ChatWindow.file-import.test.mjs`).
3. `onProjectFilesImported` is finally wired, so an import refreshes the file tree (`components/AppShell.tsx`).
4. The MCP route tests write their `!command` marker through Node with a base64 payload instead of a shell path, which is what created stray `command-ran` files in the repository root on Windows.

Reported and deliberately deferred (each needs its own decision, none blocks this release):

- The promotion window is treated as a session change, so an attachment still reading when the first message is sent is dropped rather than carried into the new session. Conservative on purpose; fixing it means exposing provisional-draft identity, which would reopen the cross-session write this loop just closed.
- macOS: `src-tauri/src/native_prefs.rs`, `desktop/server-helper-Info.plist`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json` still carry the upstream `com.abcwyc.pi-agent` identifier while the distro overlay uses `com.hao3039032.pi-agent-lw`. Affects upgrade cache cleanup and TCC prompts, not dev runs.
- `PI_WEB_SKIP_VERSION_CHECK` sets a variable nothing reads; its comment still describes the removed `/api/app-update` route.
- `scripts/upstream-css-baseline.json` keeps `upstreamRef: c8da553`. The stylesheets themselves were verified identical to abcwyc v0.7.4 with a real diff; the ref only records the last upstream release that owned those files.
- `lib/mcp-host.test.mjs`'s idle-connection case failed once under the app shell. It was not reproduced after the environment fix, uses a stub transport rather than a child process, and its 20 ms idle timer against a 50 ms wait is tight — recorded as an unproven suspicion, not as a source defect.

Final parent-run validation after the fixes: **1040/1040** UI/hooks/scripts, **103/103** release-tool tests, `51` MCP host cases with `50 passed, 1 skipped` under a clean environment, `4/4` focused MCP marker tests, plus TypeScript and lint. Still not run: production build, packaged native smoke test, browser E2E, and the full server suite on Linux.
