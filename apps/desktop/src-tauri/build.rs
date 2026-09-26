//! Tauri's build step runs for the Windows target only.
//!
//! THE CHECK IS `CARGO_CFG_TARGET_OS` AND NOT `cfg!(windows)`, and the
//! difference is the whole reason this file has a comment. A build script is
//! compiled for the HOST, so `cfg!(windows)` here asks which machine is doing
//! the building -- exactly the wrong question when the point is cross-checking
//! a Windows binary from Linux, which is how this crate is verified.
//!
//! `tauri-build` itself is an unconditional build-dependency for the same
//! reason: a `cfg(windows)` build-dependency would be absent precisely when
//! cross-compiling from Linux. It reads configuration and generates code; it
//! links no GUI toolkit. Whether it RUNS is decided here, from the target.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default() == "windows" {
        tauri_build::build();
    }
}
