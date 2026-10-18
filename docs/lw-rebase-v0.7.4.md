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
- UI/hooks/scripts suite: compared with an isolated worktree at exactly abcwyc v0.7.4 using the same node_modules. The upstream baseline has 110 failures (including CRLF-sensitive source assertions and SSR i18n harness failures). After LW fixes, no additional failing test names remain; one old composer-alignment failure is resolved. This is NOT a fully green suite.
- Focused lib suite (distro, subagents, security inheritance, images, artifacts, locales, rpc, session reader): 390 tests, 386 passed, 3 skipped, 1 failed. The remaining failure is Windows EPERM creating a file symlink in `subagent-input.test.mjs`, reproduced on upstream. Two security-extension integration cases skip because the external packages are not installed.
- LW route tests (distro, native path classification, file imports, subagent settings): 17 tests, 16 passed, 1 skipped, no failures.
- No production build, packaged/native GUI smoke test, or browser E2E was run. No push/force-push was performed.
