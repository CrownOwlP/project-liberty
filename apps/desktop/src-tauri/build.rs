//! Tauri's build step runs for the Windows target, and only when the shell is
//! actually being built.
//!
//! TWO CONDITIONS, AND NEITHER IS `cfg!(windows)`. A build script is compiled
//! for the HOST, so `cfg!(windows)` here asks which machine is doing the
//! building -- exactly the wrong question when the point is cross-checking a
//! Windows binary from Linux. `CARGO_CFG_TARGET_OS` asks about the target.
//!
//! `CARGO_FEATURE_SHELL` is the second: `tauri-build` reads the Tauri
//! configuration and generates code the `tauri` crate consumes, so running it
//! in a `--no-default-features` build -- where `tauri` is not linked -- panics
//! inside `tauri_build::is_dev`. That build mode exists to verify this crate's
//! own Windows code while Tauri's transitive graph is broken upstream; see
//! `docs/DECISIONS.md` ADR-009.
fn main() {
    let targets_windows =
        std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default() == "windows";
    let builds_shell = std::env::var_os("CARGO_FEATURE_SHELL").is_some();
    if targets_windows && builds_shell {
        tauri_build::build();
    }
}
