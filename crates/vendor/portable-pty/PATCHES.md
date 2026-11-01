# portable-pty local patch

Source: crates.io `portable-pty` 0.9.0, archive SHA-256
`b4a596a2b3d2752d94f51fac2d4a96737b8705dddd311a32b9af47211f08671e`.
The upstream license and VCS metadata are retained. Only the crate manifest and
source files needed to build the library are copied.

Local patch: Unix `SlavePty::spawn_command_in_directory` takes ownership of
an authorized directory descriptor. The Unix PTY implementation uses `fchdir`
in its existing child pre-exec callback before closing inherited descriptors;
the descriptor is also marked close-on-exec. Other implementations reject the
new operation by default. Existing Unix `spawn_command` behavior is unchanged.

Windows adds an opt-in `spawn_command_contained`: `CreateProcessW` creates the
ConPTY child suspended, `AssignProcessToJobObject` joins a private job before
`ResumeThread`, and its killer terminates the job. Failures attempt termination
and wait for the process; unconfirmed cleanup is explicitly reported. This API
**does not secure the cwd path**: callers must retain an independently authorized,
rename-blocking directory handle chain until process creation completes. It is
not wired into the desktop host and has not been compiled or exercised on Windows.
Windows child/killer now return the actual `TerminateProcess` result rather than
reversing success and failure.
