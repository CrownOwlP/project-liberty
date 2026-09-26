//! The Liberty desktop shell (PW-0102).
//!
//! A LIBRARY BESIDE THE BINARY, so that every decision in it can be unit-tested
//! without producing or running a Windows executable -- which nothing in the
//! development environment can do. The binary is a `main` that calls one
//! function; everything worth reviewing is here.
//!
//! WHAT IS PROVEN AND WHAT IS NOT, stated at the top because the distinction is
//! the whole honesty of this task:
//!
//!   PROVEN HERE -- `cargo test` on Linux covers the handshake contract, the
//!   supervision budget, the launch plan and the failure text. `cargo check
//!   --target x86_64-pc-windows-msvc` proves the Windows-only code, including
//!   the Job Object calls, COMPILES for Windows.
//!
//!   NOT PROVEN ANYWHERE YET -- that the shell launches, that WebView2 renders,
//!   that the Job Object kills the sidecar in practice, that the installer
//!   works. Those are observations on a Windows runner or the commander's
//!   machine and are owed to PW-0601. No gate recorded from this environment may
//!   imply otherwise.

pub mod failure;
pub mod handshake;
pub mod job;
pub mod sidecar;
pub mod supervision;

/// Start the shell.
///
/// UNIMPLEMENTED ON PURPOSE, AND THE PANIC IS THE POINT. Every part of this
/// task that can be settled without a Windows machine has been settled and
/// tested -- the handshake contract, the supervision budget, the launch plan,
/// the Job Object calls and the failure text. What remains is the runtime
/// assembly: spawn the child, read its stdout, assign it to the job, point a
/// `WebviewWindow` at the origin, and show a failure window when
/// `failure::describe` produces one.
///
/// That assembly cannot be VERIFIED here. It can only be verified by launching
/// it, and nothing in the development environment can launch a Windows
/// application. Writing it anyway would produce a body that compiles, that no
/// test exercises, and that a gate would then be recorded against -- which is
/// the shape of claim gpt-architect's ruling forbids: no actual Windows launch,
/// compositing or installer evidence until a Windows runner or the commander's
/// machine observes it.
///
/// So the honest state is a stub that names what is missing, and PW-0501 --
/// which already declares `.github/workflows/windows.yml` and `apps/desktop/**`
/// -- is where the runner that can observe it belongs.
pub fn run() -> ! {
    panic!(
        "the desktop shell's runtime assembly is not implemented: the parts that can be \
         verified without Windows are in this crate and tested, and wiring them together is \
         owed to a Windows runner (PW-0501) or a real-device observation (PW-0601)"
    );
}
