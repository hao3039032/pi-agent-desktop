//! Errors for the pi RPC host.
//!
//! Mirrors the failure modes of lib/pi-rpc/client.ts: transport faults (spawn,
//! exit, broken pipe), command failures (the child answered
//! `success: false`), command timeouts (the child kept running — the caller
//! decides whether and how to retry; a timed-out prompt may still have been
//! delivered, so nothing here auto-resends), and UI-window cancellations.

use std::fmt;

#[derive(Debug, Clone)]
pub struct PiRpcError {
    pub kind: ErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// The executable could not be spawned (ENOENT/EACCES equivalent).
    Spawn,
    /// The child exited (orderly or not); pending commands were rejected.
    Exit,
    /// The command timed out. The child may still be running and the command
    /// may still have taken effect — never resend blindly.
    Timeout,
    /// The child answered `{ success: false }`.
    Command,
    /// The host is shutting the child down; the request was dropped.
    Closing,
    /// The request was malformed before it was sent (e.g. non-string id).
    Invalid,
}

impl PiRpcError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }

    pub fn spawn(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Spawn, message)
    }

    pub fn exit(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Exit, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Timeout, message)
    }

    pub fn command(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Command, message)
    }

    pub fn closing(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Closing, message)
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, message)
    }
}

impl fmt::Display for PiRpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for PiRpcError {}

/// A bridge op the child refused, carrying its machine-readable code.
#[derive(Debug, Clone)]
pub struct BridgeOpError {
    pub op: String,
    pub message: String,
    pub code: Option<String>,
}

impl fmt::Display for BridgeOpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "pi-web bridge '{}' failed: {}", self.op, self.message)?;
        if let Some(code) = &self.code {
            write!(f, " (code {})", code)?;
        }
        Ok(())
    }
}

impl std::error::Error for BridgeOpError {}
