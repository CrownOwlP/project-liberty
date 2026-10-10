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
use std::fs::OpenOptions;
use std::io::Write;
use std::process::{Child as StdChild, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::failure::FailureReport;
use crate::job::KillOnCloseJob;
use crate::job::JobError;
use crate::shell::{Child, HandshakeOutcome, ShellHost};
use crate::sidecar::WritableDirectories;
use crate::sidecar_log::SidecarLog;
use crate::sidecar::{launch_arguments, SidecarLaunch};

/// The event the failure window listens for.
///
/// An event rather than a second window built here: the frontend already exists
/// and is the right place to render text a person reads. The shell's job is to
/// have something to say.
pub const FAILURE_EVENT: &str = "liberty://startup-failure";

/// How long to wait for the webview thread to install the credential header.
///
/// Short on purpose. This runs between the handshake and the navigation, with
/// the user looking at nothing, and the event loop it waits on has only just
/// been asked to do one small thing. A wedge here is a startup failure with a
/// sentence in it, not a shell that never returns.
const AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(10);

/// The header `apps/web/src/lib/sidecar/policy.ts` requires. Deliberately not
/// `Authorization`: that name invites a proxy, a logger or a library to treat
/// it as a bearer token for somewhere else.
const SIDECAR_TOKEN_HEADER: &str = "x-liberty-sidecar-token";

/// Make the webview present `token` on requests whose URI starts with
/// `expected_prefix`, by intercepting them.
///
/// SPLIT OUT OF THE TRAIT METHOD SO THE COM SEQUENCE READS IN ONE PLACE, and
/// because everything in here is a call into WebView2 -- the part of this file
/// the module header says no test in this repository can exercise.
///
/// TWO LAYERS OF SCOPING, AND THE SECOND IS NOT REDUNDANT. `filter` is what
/// WebView2 matches on, and its wildcard semantics are Microsoft's rather than
/// ours; `expected_prefix` is re-checked inside the handler against the URI the
/// request actually carries. A credential is worth one string comparison per
/// request to be certain it is not leaving for somewhere the child never named.
fn install_token_header(
    webview: &tauri::webview::PlatformWebview,
    filter: &str,
    expected_prefix: &str,
    token: &str,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    };
    use webview2_com::WebResourceRequestedEventHandler;
    use windows::core::{HSTRING, PCWSTR};

    let core: ICoreWebView2 = unsafe { webview.controller().CoreWebView2() }
        .map_err(|error| format!("the webview has no CoreWebView2: {error}"))?;

    let filter_wide = HSTRING::from(filter);
    unsafe {
        core.AddWebResourceRequestedFilter(
            PCWSTR(filter_wide.as_ptr()),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        )
    }
    .map_err(|error| format!("the request filter for the sidecar origin was refused: {error}"))?;

    let expected_prefix = expected_prefix.to_string();
    let token = HSTRING::from(token);
    let header = HSTRING::from(SIDECAR_TOKEN_HEADER);
    let mut registration = 0i64;

    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_sender, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let request = unsafe { args.Request() }?;

        /*
         * THE SECOND SCOPING CHECK. If the URI cannot be read, or does not
         * start with the origin the child reported, the request is passed
         * through UNTOUCHED. Not refused -- refusing other origins is not this
         * handler's job and would break the webview for everything else -- just
         * not given the credential.
         */
        /* `Uri` writes into an out-parameter and the CALLER OWNS the string.
         * `take_pwstr` is webview2-com's own reader for exactly that: it reads
         * and then frees with CoTaskMemFree. `string_from_pcwstr` beside it
         * only reads, so using that one would leak a string per request --
         * and this handler runs on every request the page makes. */
        let mut uri = windows::core::PWSTR::null();
        unsafe { request.Uri(&mut uri) }?;
        let uri = webview2_com::take_pwstr(uri);
        if !uri.starts_with(&expected_prefix) {
            return Ok(());
        }

        let headers = unsafe { request.Headers() }?;
        unsafe { headers.SetHeader(PCWSTR(header.as_ptr()), PCWSTR(token.as_ptr())) }?;
        Ok(())
    }));

    unsafe { core.add_WebResourceRequested(&handler, &mut registration) }
        .map_err(|error| format!("the request interceptor was refused: {error}"))?;

    Ok(())
}

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

    fn data_dir(&mut self) -> Result<PathBuf, String> {
        /*
         * `app_local_data_dir`, NOT `app_data_dir` -- LOCAL, never roaming, and
         * the difference is measured in gigabytes on a domain (PW-0501).
         *
         * Tauri's `app_data_dir` resolves to the ROAMING known folder on
         * Windows (`%APPDATA%`), which a corporate profile service copies
         * between every machine the user signs in to. This application's
         * writable root holds a media cache and a local store; putting that on
         * the roaming path would make every sign-in a sync of state that is
         * meaningless on another machine, and the person whose logon takes
         * twenty minutes would have no way to know why.
         *
         * `app_local_data_dir` is `%LOCALAPPDATA%\<identifier>`, which is the
         * known folder Windows documents for exactly this, resolved through the
         * platform API rather than by reading the variable -- so a redirected
         * profile is honoured instead of guessed at.
         */
        self.app.path().app_local_data_dir().map_err(|error| {
            format!("the per-user application data directory could not be located: {error}")
        })
    }

    fn create_directories(&mut self, directories: &WritableDirectories) -> Result<(), String> {
        /*
         * `create_dir_all`, which is idempotent -- after the first launch these
         * all exist and that is the normal answer, not an error.
         *
         * THE PATH IS IN THE MESSAGE. This is the failure a person is most
         * likely to be able to act on -- disk space, a redirected folder, a
         * security product holding a handle -- and a report that said only
         * "access denied" would tell them nothing about where.
         */
        for directory in directories.all() {
            std::fs::create_dir_all(directory).map_err(|error| {
                format!("{} could not be created: {error}", directory.display())
            })?;
        }
        Ok(())
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
        /*
         * STDERR IS CAPTURED, NOT DISCARDED (PL-0734). It used to be
         * `Stdio::null()`, which meant a Node stack trace printed on the way
         * down went to the kernel's bit bucket -- and on a packaged build, on
         * a machine no engineer can reach, that was the entire explanation
         * for an unanticipated startup failure.
         */
        command.stderr(Stdio::piped());
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
        let stderr = process
            .stderr
            .take()
            .ok_or_else(|| "the sidecar was started with no stderr pipe".to_string())?;

        /*
         * ONE LOG FILE, TRUNCATED PER LAUNCH, WRITTEN AS THE CHILD RUNS.
         *
         * APPENDED LINE BY LINE RATHER THAN AT EXIT, and that is the whole
         * requirement: the job object kills this child when the shell goes,
         * and a killed process never reaches an exit path. Anything buffered
         * until then is exactly the output of the crash nobody can explain.
         *
         * BEST EFFORT, NEVER FATAL. If the file cannot be opened the launch
         * proceeds with no log. A shell that refused to start because it
         * could not write a diagnostic would have turned an observability
         * gap into an outage -- a new unsafe startup path, which this task
         * is forbidden to create.
         *
         * TRUNCATED per launch (`.truncate(true)`) rather than appended
         * across them: the question this file answers is "why did THIS start
         * fail", and a reader handed six runs interleaved has to work out
         * which lines are theirs first.
         */
        let log_path = launch.writable.logs.join("sidecar.log");
        let mut sink = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log_path)
            .ok();
        if sink.is_none() {
            // Said on stdout rather than swallowed: the person reading a
            // console knows why the file they were told to attach is absent.
            eprintln!("liberty: no sidecar log; {} could not be opened", log_path.display());
        }

        let token = launch
            .env
            .iter()
            .find(|(name, _)| name == crate::sidecar::TOKEN_VAR)
            .map(|(_, value)| value.clone())
            .unwrap_or_default();
        let mut log = SidecarLog::new(&token);
        log.note(&format!("launching {}", launch.node.display()));

        let (sender, lines) = mpsc::channel();
        let (log_tx, log_rx) = mpsc::channel::<(String, String)>();

        /*
         * THE WRITER IS ITS OWN THREAD so neither reader blocks on disk, and
         * it owns the `SidecarLog` so the budget and the redaction are
         * applied in exactly one place.
         */
        std::thread::spawn(move || {
            let flush = |log: &mut SidecarLog, sink: &mut Option<std::fs::File>| {
                let pending = log.take();
                if pending.is_empty() {
                    return;
                }
                if let Some(file) = sink.as_mut() {
                    // A write failure stops the logging, never the launch.
                    let _ = file.write_all(pending.as_bytes());
                    let _ = file.flush();
                }
            };
            flush(&mut log, &mut sink);
            while let Ok((stream, line)) = log_rx.recv() {
                log.line(&stream, &line);
                flush(&mut log, &mut sink);
            }
        });

        let out_log = log_tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = out_log.send(("out".to_string(), line.clone()));
                if sender.send(line).is_err() {
                    // The receiver is gone: the launch was abandoned. Keep
                    // draining so the child never blocks on a full pipe --
                    // and keep LOGGING, because the interesting output of a
                    // failed start arrives after the handshake gave up.
                    continue;
                }
            }
        });

        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = log_tx.send(("err".to_string(), line));
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

    fn authorize_webview(&mut self, origin: &str, token: &str) -> Result<(), String> {
        /*
         * WHY THIS EXISTS AT ALL. `apps/web/src/proxy.ts` refuses every request
         * that does not carry `x-liberty-sidecar-token`, and its matcher
         * excludes only Next's immutable static output -- so the DOCUMENT
         * request is refused too. `show_window` below loads the page with a
         * plain top-level navigation, which carries no headers. Before this
         * method the window opened on a 403 with no body.
         *
         * WHY INTERCEPTION AND NOT SOMETHING SIMPLER. A query parameter would
         * put a per-launch secret in a URL, in history and in any log that
         * records one. A cookie cannot be set before the first request, which
         * is the one that is refused. Exempting document requests in the proxy
         * would weaken the guard for every caller, not just this one. This is
         * the shell presenting a credential it minted, on requests it can see,
         * to an origin the child named -- which is what the handshake was for.
         */
        let window = self
            .app
            .get_webview_window("main")
            .ok_or_else(|| "the main window does not exist".to_string())?;

        /*
         * SCOPED TO THIS ORIGIN AND NOTHING ELSE. This filter is the only thing
         * standing between a per-launch secret and every other host the webview
         * might ever reach, so it is built from the origin the CHILD reported --
         * `handshake::parse` has already refused any host that is not a loopback
         * literal -- and never from a wildcard.
         */
        let filter = format!("{origin}/*");
        let expected_prefix = format!("{origin}/");
        let token = token.to_string();

        /*
         * `with_webview` DISPATCHES TO THE THREAD THAT OWNS THE WEBVIEW, and
         * this method runs on the shell thread `lib.rs` spawned. So the result
         * comes back over a channel: without it this would return Ok before the
         * filter existed, and `start_once`'s ordering guarantee would be a
         * comment rather than a fact. The timeout is here because a wedged
         * event loop must not wedge the shell -- it becomes a startup failure
         * with a sentence in it, like every other failure on this path.
         */
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        window
            .with_webview(move |webview| {
                let outcome = install_token_header(&webview, &filter, &expected_prefix, &token);
                let _ = tx.send(outcome);
            })
            .map_err(|error| format!("the webview could not be reached: {error}"))?;

        match rx.recv_timeout(AUTHORIZE_TIMEOUT) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err(format!(
                "the webview did not accept the sidecar credential within {} seconds",
                AUTHORIZE_TIMEOUT.as_secs()
            )),
            Err(RecvTimeoutError::Disconnected) => {
                Err("the webview thread ended before accepting the sidecar credential".to_string())
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
