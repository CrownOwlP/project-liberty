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
pub mod shell;
pub mod sidecar;
pub mod supervision;
pub mod token;

/// The Windows implementation of `ShellHost`. Compiled for Windows only; see
/// its header for why a cross-platform stub would be worse than its absence.
#[cfg(windows)]
pub mod windows_host;

/// Start the shell.
///
/// The Tauri event loop runs on the main thread, because Windows requires it;
/// the sidecar's lifetime runs on a worker, because `run_shell` blocks for as
/// long as the application lives.
///
/// WHY THE SUPERVISOR IS NOT ON THE MAIN THREAD: it waits on a handshake, sleeps
/// between restarts and blocks on the child's exit. Any of those on the UI
/// thread is a window that stops repainting, which on Windows is a window the
/// shell reports as "not responding".
///
/// WHAT STILL IS NOT PROVEN HERE. This compiles for Windows and its ordering is
/// tested through `ShellHost`. That the window appears, that WebView2 renders,
/// that the Job Object terminates the sidecar, and that an installer works are
/// observations owed to a Windows runner or the commander's machine. No gate
/// recorded from this environment may imply otherwise.
#[cfg(windows)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                /*
                 * THE JOB OBJECT LIVES INSIDE THIS HOST, AND THAT IS HOW THE
                 * SIDECAR DIES WITH THE APPLICATION.
                 *
                 * On an ordinary exit the host is dropped and `KillOnCloseJob`
                 * closes the handle, which is what fires
                 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. On an ABNORMAL exit --
                 * the shell crashing, or Task Manager ending it -- no `Drop`
                 * runs, and the kernel closes the process's handles anyway,
                 * which fires the same limit. That second case is the entire
                 * reason a job object was chosen over any user-mode cleanup:
                 * `job.rs` records the four alternatives and why each fails
                 * exactly there.
                 *
                 * So the handle is deliberately held nowhere else. A copy in a
                 * global, or one leaked to keep it "safe", would outlive this
                 * host and defeat the mechanism.
                 */
                let mut host = windows_host::WindowsHost::new(handle);
                let outcome = shell::run_shell(&mut host, &|| {
                    token::mint().map_err(|error| error.to_string())
                });
                /*
                 * The loop has finished, which means the budget is spent and the
                 * user has been told. The window stays up showing that message
                 * rather than the process exiting out from under it: an
                 * application that vanishes is the failure nobody can report.
                 */
                let _ = outcome;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the Tauri event loop could not start");
}

/// The shell does not run off Windows, and says so rather than pretending.
///
/// This crate builds on Linux so its decisions can be tested where the work is
/// done. It does not follow that there is a Linux application: there is no
/// WebView2, no job object, and no packaged `node.exe`. A stub that started
/// something anyway would be a shell with no supervision, which `job.rs`
/// already refuses to be.
#[cfg(not(windows))]
pub fn run() {
    eprintln!(
        "liberty-desktop is a Windows application. This build exists so the shell's decisions \
         can be tested on the machine they are written on; it has no webview and no process \
         supervision, so it will not start one."
    );
    std::process::exit(2);
}
