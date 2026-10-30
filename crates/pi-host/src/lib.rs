//! # pi-host — Rust host for `pi --mode rpc` child processes
//!
//! M0 proof-of-concept of the “去 Next.js：静态前端 + Tauri/Rust 应用宿主”
//! migration plan (plans/2026-10-31): the session engine no longer runs in a
//! Node/Next backend; the Rust desktop host spawns one pi CLI child per
//! active session. This crate is the port of the TypeScript RPC layer:
//!
//! - [`client`] — `lib/pi-rpc/client.ts`: JSONL framing, command/response
//!   correlation, session-event fan-out, the extension-UI subprotocol with
//!   the pre-attach hold window, stderr diagnostics, orderly shutdown and
//!   process-tree kill;
//! - [`bridge`] — the bridge parts of `lib/pi-rpc/core.ts`: the
//!   `/pi-web:bridge` request/reply channel over the notify UI method, with
//!   nonce/session verification and the ack/result race.
//!
//! The session state machine itself (`session.ts`, `core.ts` wrapper members,
//! `rpc-manager.ts`) is M2 scope; this crate proves the transport first.
//!
//! ## Verification
//!
//! - `tests/mock_protocol.rs` — deterministic protocol tests against a fake
//!   child (`src/bin/mock_pi.rs`): framing edge cases (chunked UTF-8,
//!   U+2028/U+2029, multi-record writes), correlation, timeouts that leave
//!   the child alive, the UI hold window (arrival-order replay, cancel on
//!   deadline/overflow/exit, the bypass channel), exit propagation and the
//!   grace-kill shutdown path.
//! - `tests/real_pi.rs` — real-pi integration tests gated on `PI_CLI_BIN`
//!   (the same convention as lib/pi-rpc/*.smoke.test.mjs), fully sandboxed
//!   through `PI_CODING_AGENT_DIR`: get_state handshake, session identity,
//!   the shipped bridge asset's tools.list, nonce rejection and orderly
//!   shutdown.
//!
//! ## Known divergences from the TypeScript client
//!
//! - held-dialog expiry uses `arrival + timeout` (a duration), not a
//!   comparison against the wall clock;
//! - a command whose write lands after shutdown began fails immediately
//!   (`ErrorKind::Closing`) instead of silently timing out later.

pub mod bridge;
pub mod client;
pub mod error;
pub mod framing;

pub use bridge::{Bridge, BridgeError, BridgeOpError, BRIDGE_COMMAND};
pub use client::{
    EnvPolicy, PiRpcClient, SpawnOptions, UiRequest, UI_ATTACH_MAX_ENTRIES,
};
pub use error::{ErrorKind, PiRpcError};
