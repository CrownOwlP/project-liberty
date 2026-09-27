//! The Windows implementation of `ShellHost` (PW-0102).
//!
//! WHAT THIS FILE IS AND WHY IT IS THIN. `shell.rs` owns the ORDER in which a
//! shell starts, and that order is tested. This file owns the platform calls
//! that order drives -- spawning a process, reading its stdout, assigning it to
//! a job, moving a webview. Every line of it is a call into Windows or Tauri,
//! which is exactly the part no test in this repository can exercise:
//! `cargo check --target x86_64-pc-windows-msvc` proves it compiles, and
//! nothing here proves it runs.
//!
//! THAT SPLIT IS DELIBERATE AND IS THE ANSWER TO "Windows is required to VERIFY
//! it, not to WRITE it". The decisions are written and verified; the syscalls
//! are written and owed an observation.
//!
//! COMPILED FOR WINDOWS ONLY. The shell is a Windows product; a Linux build of
//! this file would be a stub pretending to supervise, which `job.rs` already
//! refuses to be. THE GATE IS ON THE MODULE DECLARATION -- `#[cfg(windows)]`
//! above `pub mod windows_host;` in `lib.rs` -- and it is there and nowhere
//! else. This file used to ALSO carry an inner `#![cfg(windows)]`, which was
//! redundant: a module that is not declared cannot be reached, so the inner
//! attribute could only ever be evaluated in a build where it was already
//! true. It was removed on the commander's round-89 corrective. Do not add it
//! back; one gate that can be seen from the declaration site is worth more
//! than two that have to agree.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child as StdChild, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::failure::FailureReport;
use crate::job::KillOnCloseJob;
use crate::job::JobError;
use crate::shell::{Child, HandshakeOutcome, ShellHost};
use crate::sidecar::{launch_arguments, SidecarLaunch};

/// The event the failure window listens for.
///
/// An event rather than a second window built here: the frontend already exists
/// and is the right place to render text a person reads. The shell's job is to
/// have something to say.
pub const FAILURE_EVENT: &str = "liberty://startup-failure";

pub struct WindowsChild {
    process: StdChild,
    /// Lines the reader thread has produced, in order.
    lines: mpsc::Receiver<String>,
}

impl Child for WindowsChild {}

pub struct WindowsHost {
    app: AppHandle,
    job: Option<KillOnCloseJob>,
}

impl WindowsHost {
    pub fn new(app: AppHandle) -> Self {
        Self { app, job: None }
    }
}

impl ShellHost for WindowsHost {
    type Proc = WindowsChild;

    fn resource_dir(&mut self) -> Result<PathBuf, String> {
        /*
         * TAURI'S SUPPORTED RESOURCE API, not a path relative to the current
         * directory. The relative form works under `cargo run` and breaks in an
         * installed build, which is the classic way this fails late -- after
         * packaging, on somebody else's machine.
         */
        self.app
            .path()
            .resource_dir()
            .map_err(|error| format!("the packaged resource directory could not be located: {error}"))
    }

    fn resource_exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn create_job(&mut self) -> Result<(), JobError> {
        self.job = Some(KillOnCloseJob::create()?);
        Ok(())
    }

    fn spawn(&mut self, launch: &SidecarLaunch) -> Result<WindowsChild, String> {
        let mut command = Command::new(&launch.node);
        command.args(launch_arguments(launch));
        /*
         * THE ENVIRONMENT IS WHERE THE TOKEN TRAVELS, and `launch.env` is the
         * only channel: `launch_arguments` is asserted never to contain it.
         * `.envs` ADDS to the inherited environment rather than replacing it,
         * which is what Node needs -- PATH and SystemRoot among others -- and
         * the values that matter here are set explicitly on top.
         */
        command.envs(launch.env.iter().map(|(name, value)| (name, value)));
        command.stdout(Stdio::piped());
        command.stderr(Stdio::null());
        command.stdin(Stdio::null());

        let mut process = command
            .spawn()
            .map_err(|error| format!("the packaged Node runtime could not be started: {error}"))?;

        /*
         * STDOUT IS READ ON ITS OWN THREAD, AND THAT IS NOT AN OPTIMISATION. A
         * child whose stdout pipe fills blocks forever, so the parent must
         * drain it whatever else it is doing -- and the parent is about to wait
         * on a handshake with a timeout. Reading inline would mean a child that
         * logs more than a pipe buffer before its handshake deadlocks the
         * launch.
         */
        let stdout = process
            .stdout
            .take()
            .ok_or_else(|| "the sidecar was started with no stdout pipe".to_string())?;
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    // The receiver is gone: the launch was abandoned. Keep
                    // draining so the child never blocks on a full pipe.
                    continue;
                }
            }
        });

        Ok(WindowsChild { process, lines })
    }

    fn assign_to_job(&mut self, child: &WindowsChild) -> Result<(), JobError> {
        let job = self
            .job
            .as_ref()
            .ok_or_else(|| JobError::Assign("no job was created".into()))?;
        /*
         * `RawHandle` from `std::os::windows` is the process handle the `Child`
         * owns; the job holds it only for as long as the child does. Casting is
         * the documented way to hand a std handle to a Win32 call.
         */
        use std::os::windows::io::AsRawHandle;
        job.assign(child.process.as_raw_handle() as _)
    }

    fn kill(&mut self, child: &mut WindowsChild) {
        /*
         * Best effort, and a failure is ignored on purpose: every path that
         * calls this is already reporting a different failure, and "could not
         * kill the process we were about to tell you did not start" is not a
         * message that helps anybody. The job object is the backstop -- when
         * this process exits, the kernel terminates whatever is still in it.
         */
        let _ = child.process.kill();
    }

    fn await_handshake(&mut self, child: &mut WindowsChild, within: Duration) -> HandshakeOutcome {
        let deadline = std::time::Instant::now() + within;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return HandshakeOutcome::TimedOut;
            }
            match child.lines.recv_timeout(remaining) {
                Ok(line) => {
                    if let Some(outcome) = crate::shell::classify_line(&line) {
                        return outcome;
                    }
                    // Not a handshake line. Next.
                }
                Err(RecvTimeoutError::Timeout) => return HandshakeOutcome::TimedOut,
                Err(RecvTimeoutError::Disconnected) => {
                    /*
                     * The reader thread ended, which means stdout closed, which
                     * means the child is gone. Distinguished from a timeout
                     * because the remedies differ: a dead child will not arrive
                     * late.
                     */
                    return HandshakeOutcome::ChildExited;
                }
            }
        }
    }

    fn show_window(&mut self, origin: &str) -> Result<(), String> {
        let window = self
            .app
            .get_webview_window("main")
            .ok_or_else(|| "the main window does not exist".to_string())?;
        let url = origin
            .parse()
            .map_err(|error| format!("the sidecar reported an origin that is not a URL: {error}"))?;
        window
            .navigate(url)
            .map_err(|error| format!("the webview would not navigate: {error}"))?;
        /*
         * SHOWN ONLY NOW. `tauri.conf.json` creates the window with
         * `visible: false`, so the user never sees an empty frame waiting for a
         * server -- which is the blank window this whole design exists to avoid.
         */
        window
            .show()
            .map_err(|error| format!("the window would not become visible: {error}"))
    }

    fn surface_failure(&mut self, report: &FailureReport) {
        /*
         * THE WINDOW IS SHOWN FOR A FAILURE TOO. A shell that fails silently and
         * exits is indistinguishable, to a user, from one that never ran -- and
         * that is the "it just doesn't open" report nobody can act on.
         */
        let _ = self.app.emit(
            FAILURE_EVENT,
            serde_json::json!({
                "headline": report.headline,
                "detail": report.detail,
                "retryMayHelp": report.retry_may_help,
            }),
        );
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.show();
        }
    }

    fn await_exit(&mut self, mut child: WindowsChild) -> Duration {
        let started = std::time::Instant::now();
        let _ = child.process.wait();
        started.elapsed()
    }

    fn sleep(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }
}
