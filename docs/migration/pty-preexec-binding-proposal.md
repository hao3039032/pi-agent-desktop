# Linux PTY pre-exec identity handshake — proposal, not implementation

This is a design and fault-test plan for the pending PTY shutdown work. It is
**not approved production behavior**, not a claim that every blocked `spawn`
can be reclaimed, and not a cross-platform or detached-process-tree solution.
In particular, the observation-only `shutdown()` checkpoint is not a compatible
replacement for the existing termination behavior.

Source references below describe the PTY worktree at `f94a927d`, an ancestor
of the proposal commit `c06be727`, not an integrated production implementation.
In particular, the vendored source and observation-only shutdown changes are
not brought into the main branch by adding this document.

## Existing seam and the blocking limit

`crates/vendor/portable-pty/src/unix.rs` builds a `std::process::Command`,
attaches its PTY slave to standard streams, and performs signal reset, `setsid`,
`TIOCSCTTY`, pinned-directory `fchdir`, and `close_random_fds` in `pre_exec`.
It calls `cmd.spawn()` synchronously. `PtyHost::create` currently holds the
registry lock across that call. A challenge wait in `pre_exec` prevents the
parent's `spawn()` call from returning its `Child`; therefore the registry lock
must not cover spawn or the shutdown coordinator cannot enumerate the attempt.
The parent also cannot get a `Child` from that call while the child is stopped
before the handshake. Ordinarily it waits for exec/error; the existing fd
sweep caveat below can instead prematurely close its internal channel. Closing
the handshake pipes cannot wake a `SIGSTOP`ped child. A timeout on another thread cannot cancel or join a thread blocked in
`spawn()`. A fixed thread limit bounds the number of blocked workers but does
not make them reclaimable. This is a **production blocker**, not an accepted
single-slot implementation.

The existing vendor `close_random_fds()` also uses `read_dir`, `Vec`, and
string conversion inside `pre_exec`, and closes every fd above 2. It is not an
async-signal-safe implementation and may close Rust's internal spawn-error
channel before exec. A handshake patch cannot claim the whole pre-exec path is
safe merely by making the new pipe operations safe. Audit and replace the sweep
with a no-allocation strategy which preserves the standard library's private
spawn-error mechanism until exec (e.g. an audited Linux close-on-exec-only range
operation with a bounded fallback), without guessing its fd number. That is a
separate design/approval gate, not an implementation in this document.

## Candidate handshake and ownership

Linux only, subject to separate approval and a proof that the endpoint
ownership described below is enforceable in this host:

1. Under a short registry lock, check admission and insert a unique attempt ID
   in `Reserved` before any worker or fork. Reserve one bounded coordinator slot
   and allocate all bootstrap descriptors with close-on-exec; on failure record
   the failure and release the reservation only if no child can exist. A single
   admitted attempt owns its records; it is never identified solely by PID.
2. A bounded spawn worker owns the `Command`, PTY slave and directory handle;
   the registry owns the attempt and parent handshake pipe ends. The worker calls
   `spawn()` **outside** the registry lock and reports its result to the
   coordinator. No detached, per-timeout retry threads. This move is a proposal;
   it does not solve the non-reclaimable `spawn()` case above.
3. In child `pre_exec`, before `close_random_fds`, perform only audited
   async-signal-safe operations on preallocated fixed-size buffers and raw FDs.
   No Rust locks, heap allocation, formatting, logging, random generation or
   calls into arbitrary extension code. The existing signal/session/TTY and
   `fchdir` operations must be audited without weakening their checks. The private
   identity exchange must precede the fd-closing sweep; all handshake FDs
   must be closed before user exec and marked close-on-exec as a backstop.
4. Use the narrower candidate: two per-attempt, unidirectional pipes created
   before fork. The parent owns only challenge-write and response-read ends;
   the child owns challenge-read and response-write ends after explicitly
   closing the opposite ends in `pre_exec`. All ends are close-on-exec. An
   unrelated concurrent fork may temporarily inherit extra references before
   it execs; that can delay EOF or consume bytes, but an extra reference alone
   is not a correct response to a fresh, post-pidfd nonce. Reject partial,
   unsolicited, duplicated, wrong or late messages and never treat EOF timeout
   as proof. Check protocol framing and prevent inherited ends from entering an
   executed user program. Do not add `SCM_RIGHTS` or a second protocol merely
   because an fd reference may be inherited.

   This argument relies on the fixed trusted host: no unrelated pre-exec hook
   deliberately reads these attempt FDs or shared parent memory, and only the
   intended child sends protocol responses. A malicious in-process pre-exec
   hook with arbitrary FD/memory access could steal the nonce and forge a
   response; decide explicitly whether that is outside the supported threat
   boundary rather than calling CLOEXEC a proof against it. A source search of
   this checkout found repository pre-exec hooks in the vendored PTY,
   `worktrees.rs`, and `file_directory_unix.rs`; the latter two perform their
   own directory setup and do not knowingly read this protocol. Other command
   spawns exist, and dependencies/native libraries and concurrent forks have
   **not** been exhaustively audited. Before claiming the precondition, audit
   all reachable host hooks and fd inheritance, including executed helpers.
   An unproven trusted-host precondition remains a blocker.
5. On a validated ready message, coordinator opens a pidfd for its reported
   PID. **Only after `pidfd_open` returns**, generate a new unpredictable nonce
   in the parent, send it on the challenge pipe, and require an exact fixed-size
   echo on the response pipe. Until that
   response arrives, the fd is `UnboundCandidate`: never signal it. If the
   trusted-host response-origin precondition holds, the original child must
   have been alive at the instant of `pidfd_open` to answer the new challenge. A ready message,
   numeric PID, `pidfd_open` success, `waitid`, or a nonce sent before open is
   individually insufficient. Reject EOF, duplicate/partial/wrong responses,
   unexpected descriptors/credentials and protocol errors.
6. Atomically store the `BoundLeader(pidfd)` in the existing attempt record
   before release, then send a distinct release message. If shutdown has
   already closed admission, do not release user exec; the bound pidfd may be
   signaled, subject to the same deadline. The child verifies release using
   only fixed-size reads, closes both handshake descriptors and proceeds to the
   existing fd sweep and exec. EOF, abort, or protocol error returns a fixed
   pre-exec error; it must not launch the shell. Handle `EINTR`, short I/O,
   EOF, `EPIPE`/`SIGPIPE` safely and without process-wide signal changes.
7. The worker publishes either `spawn()` success (the `Child` and its sole
   wait owner) or an explicit spawn error to the existing attempt. Successful
   registration transfers pidfd and child ownership to the terminal object.
   Both the worker and registry must tolerate shutdown racing each transition;
   no state transition may discard an unconfirmed attempt.

## State machine and failure accounting

| State | Evidence held | Allowed action and failure result |
|---|---|---|
| `Reserved` | attempt ID, no spawn begun | Closing admission prevents new reservations; if the worker has not started, cancel with no child. |
| `SpawningUnbound` | worker and handshake pipes; child may or may not exist | Poll channels only until the absolute deadline. No numeric PID/PGID signal. EOF, malformed messages, timeout, `SIGSTOP`, child death or worker lock contention => `unknown` until the worker reports an outcome that proves no child remains. Retain attempt and all potentially relevant handles. |
| `Candidate` | pidfd opened; no valid post-open response | Still **unbound**; exactly the same no-signal rule. A response received after the deadline cannot retroactively make an earlier shutdown result successful. |
| `BoundPaused` | pidfd plus verified post-open challenge response | Leader identity is bound. On cancellation/shutdown signal this pidfd only; never numeric PID or process group. `SIGKILL` can end a stopped bound leader. Retain pidfd, worker and attempt until actual exit is observed. |
| `ReleasedStarting` | bound pidfd, release sent, `spawn()` not returned | User code may run or exec may fail. No automatic retry. Signal only the bound pidfd and wait within the same global deadline. A worker blocked in spawn or kernel I/O remains tracked `unknown`. |
| `Registered` | bound pidfd, `Child`, registry entry | A single exit watcher owns reaping. Close admission first; send HUP/then KILL via pidfd with a policy bounded by the caller's **one absolute deadline**, and report `leader_exited` only after a real exit observation. Preserve the existing ordinary close grace behavior, without a PID-based delayed escalation. |
| `Exited` | actual wait/try-wait exit status | Report leader exited; it says nothing about descendants. A pidfd becoming readable is process-exit evidence but does not fabricate a `Child` wait result or a shell exit code. |
| `Unknown` | outcome or handle ownership unconfirmed | Keep registry record, handles, outstanding worker/slot and cause. Do not report success, release a slot as reusable, or silently convert a wait error to signaled exit. |

`spawn()` errors need separate handling by stage. Before fork/child creation is
proved, a failure can return an ordinary error. After child may exist but before
binding, the attempt remains `unknown` until the spawn worker's documented
result and child lifecycle establish otherwise. After binding, an error may be
followed by pidfd termination and exit observation; do not assume that an
`Err` alone proves termination or that the standard library's internal error
pipe gives the caller a reusable `Child`. If another reaper consumed a status,
`ECHILD` is **unknown**, never successful wait. A child killed or stopped before
the response cannot be bound merely because an unrelated child later reuses its
PID. A dead child cannot itself respond; the response-origin precondition excludes
another trusted-host pre-exec hook impersonating it.

A shutdown coordinator can return by its deadline while an attempt remains
`unknown`, but it cannot safely claim that a worker blocked inside `spawn()` is
reclaimed. The **proposed** capacity bound is one fixed worker per host (not a
new thread per request); any stuck worker occupies its slot and permanently
closes that admission path until an actually observed resolution. This is a
failure containment description only, **not an approved production solution**.
In particular, neither dropping a join handle nor restarting the worker pool
recovers a stopped unbound child. Any production path must resolve this boundary
with a separately approved, genuinely reclaimable supervisor/atomic-spawn
primitive or explicitly accepted product semantics.

## Termination API and compatibility

Candidate external interface stays `begin_shutdown()` followed by
`shutdown_until(Instant) -> { leader_exited, unknown }`; `unknown` includes
unresolved ranges and its length is not a process count. Once bound leader
handles exist, `shutdown_until` can actually signal *those handles* and observe
exits without blocking on application mutexes or waiting two seconds per PTY.
Unbound or non-Linux attempts remain unknown. Do not call arbitrary potentially
blocking `ChildKiller`/destructor methods from the deadline path.

Normal single-terminal `close` keeps input rejection, hangup and existing
2-second escalation semantics, but its eventual safe implementation must use
the bound pidfd for both signals and retain the instance until a real exit.
The legacy `shutdown()`/application-exit caller must not silently change from
termination to observation and then be labeled complete. Its integration must
be explicitly migrated to the result-bearing API and propagate unknown; until
there is an approved safe termination mechanism, do not merge the observation-
only replacement as a behavior-preserving implementation. Reader/master/writer
handles are duplicated: dropping just the registry's master is not proof of
PTY hangup. An alternative cooperative hangup requires documented ownership
and bounded release of every reader, writer, master clone and thread, followed
by a real leader-exit observation. Never infer that a leader's exit or a PTY
EOF proves detached descendants ended.

## Isolated failure-test plan — not yet run

A Linux test controller must own a **separate test-only, challenge-verified
pidfd** for the fixture child *before* injecting `SIGSTOP`. The fixture's child
must perform that independent test-only handshake before the production ready
point; the production path under test does not receive the test-only proof. After asserting deadline,
`unknown`, and retained attempt/worker state, the controller uses its bound
pidfd to `SIGCONT` or `SIGKILL`, waits for real exit, closes all pipes, and joins
all fixture threads. Every error/timeout path needs the same RAII cleanup; no
unverified PID-based kill, no ignored worker and no infinite test wait. If this
independent proof or deterministic cleanup cannot be established, do not run
the injection test.

Cases: normal challenge then shell I/O/resize/UTF-8/exit; SIGSTOP before ready,
after ready/before pidfd, after pidfd/before response, and after binding; death
at each boundary; a newly generated challenge checked against replay, wrong
nonce and inherited/duplicated bootstrap FD; child and parent pipe closure,
partial I/O, EINTR, exec failure and setup/thread allocation failure; another
reaper/`ECHILD` and controlled PID reuse; concurrent create/shutdown and
spawn-before-register; lock contention and multiple PTYs sharing one deadline;
repeated shutdown and normal close; reader/writer/master-clone cleanup. Test
that SIGSTOP before binding consumes at most the bounded fixture slot, returns
unknown on deadline, and **does not** establish worker reclaimability until the
test controller safely resumes or terminates it. Assert that no event or result
asserts detached descendant termination.

No macOS/Windows support follows from this Linux proposal. Windows `CreateProcessW`
and ConPTY additionally require a proven retained directory-handle chain and a
public mechanism proving when the child actually obtained cwd; macOS requires
its own safe leader-identity and process-lifecycle mechanism.
