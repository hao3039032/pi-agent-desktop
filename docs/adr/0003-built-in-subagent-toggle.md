# Built-in sub-agent activation and extension precedence

Pi Web's integrated sub-agent implementation is an inline, hidden extension.
It is disabled by default and controlled by the global
`~/.pi/agent/agents/settings.json` setting `builtInEnabled`.

The inline extension factory remains installed in every ordinary, non-Chat-only
resource loader so an AgentSession reload can enable or disable its tools without
recreating the wrapper. When disabled, the factory registers no tools. A runtime
guard also rejects stale `Agent` calls after the setting is turned off but before
the parent session is reloaded.

When a pi-subagents extension file is present in a session's extension load
result, the integrated extension yields: the host is removed from the loaded
extensions (its three delegation tools go with it) together with the conflict
diagnostics its removal dissolves, and pi-subagents' own tools are the ones the
model sees. Detection is by package source or path only — pi-subagents 0.78
registers `subagent` rather than the reserved tool names, so a reserved-name
condition would never match the current package and both tool sets would reach
the model. The Agents panel reports the package as active (`legacyPackage`, from
`readPiSubagentsPackageActive()` in `lib/subagent-settings.ts`), disables the
built-in switch and hides the built-in profile group while it is; a runtime
guard in `start()` / `resume()` rejects stale `Agent` calls and asks the user
to reload the session. That guard is best-effort and process-wide, not
per-session: it is armed only while the most recent extension load in the
process detected pi-subagents AND the global settings activate the package —
the settings half keeps a project-scoped install from rejecting `Agent` calls
from sessions in other projects, which the process-global load flag alone
would. The panel hint (`readPiSubagentsPackageActive()`) reads the global
settings only, so a project-scoped pi-subagents install still yields that
project's sessions (the extension load result is authoritative) even though
the hint reports false.

When pi-subagents is absent or disabled (removed, or its package entry's
extension filter emptied through the Plugins panel), the integrated extension
behaves exactly as before: it registers its tools when `builtInEnabled` is on
and registers nothing when it is off. Existing child sessions remain readable,
and already-running children are not aborted when the precedence flips; a
session picks the change up on its next reload, which is the existing behavior
for the switch itself.
