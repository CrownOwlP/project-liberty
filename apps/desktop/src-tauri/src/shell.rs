//! The runtime assembly: the order in which a shell starts (PW-0102).
//!
//! WHY THIS IS A TRAIT AND NOT A FUNCTION FULL OF `std::process::Command`.
//! gpt-architect's round-87 verdict is exact about the problem and about the
//! remedy: the modules implemented pieces of a shell and were not assembled
//! into one, and "Windows is required to VERIFY it, not to WRITE it". The
//! assembly is a SEQUENCE -- create the job, then spawn, then assign, then read
//! the handshake, then show -- and the sequence is where the safety lives:
//!
//!   - the job must exist BEFORE the child does, or there is nothing to assign
//!     it to and the orphan window is the whole launch rather than microseconds;
//!   - a child that cannot be assigned must be KILLED, not left running, because
//!     an unassigned child is precisely the orphaned `node.exe` this design
//!     exists to prevent;
//!   - a failure must be SURFACED, never panicked, or the user gets a window
//!     that closes itself.
//!
//! Every one of those is an ordering property, and an ordering property can be
//! tested by a fake that records calls. So the sequence lives here, behind
//! `ShellHost`, and the Windows implementation of that trait lives in
//! `windows_host.rs` where it can be compiled for Windows and observed nowhere
//! else. What this file proves is that the shell does the right things in the
//! right order; what it cannot prove is that the kernel behaves as documented.

use std::time::Duration;

use crate::failure::{describe, FailureReport, StartupFailure};
use crate::handshake::{self, Handshake, HandshakeError};
use crate::job::JobError;
use crate::sidecar::{plan_launch, LaunchError, SidecarLaunch, WritableDirectories};
use crate::supervision::{Budget, Decision, HANDSHAKE_TIMEOUT};

/// A running sidecar, from the host's point of view.
///
/// Opaque on purpose: the assembly never needs to know what a process handle
/// IS, only that it has one to assign and to wait on. That is what lets the
/// same sequence run against a fake.
pub trait Child {}

/// What reading the child's output produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeOutcome {
    /// A usable handshake. The only path to a window.
    Ready(Handshake),
    /// The child said something that claimed to be a handshake and was not.
    Rejected(String),
    /// The child exited before saying anything usable.
    ChildExited,
    /// The timeout elapsed with no handshake.
    TimedOut,
}

/// Everything the assembly needs the platform to do.
///
/// EXACTLY ONE METHOD IN THIS TRAIT TAKES A TOKEN, and it is named for what it
/// does with it.
///
/// This comment used to read "NOTHING IN THIS TRAIT TAKES A TOKEN", and that
/// was true and was wrong. The token reaches the child inside
/// `SidecarLaunch.env`, which `plan_launch` built and which `launch_arguments`
/// is asserted never to expose -- that part is unchanged, and a
/// `spawn(&SidecarLaunch)` still cannot accidentally put it on a command line,
/// because the command line is not a parameter.
///
/// What the old comment hid is that the WEBVIEW also has to present that token
/// and nothing gave it one. `apps/web/src/proxy.ts` refuses every request that
/// does not carry `x-liberty-sidecar-token`, the matcher excludes only Next's
/// immutable static output, and `show_window` loads the page with a plain
/// top-level navigation that carries no headers. So the first page load was
/// refused with 403 and no body and the window showed nothing. A property
/// stated as "nothing takes a token" is comfortable; it was also the shape of
/// the bug.
///
/// `authorize_webview` is therefore the one place a token crosses this trait,
/// its name says so, and `start_once` calls it immediately before
/// `show_window` so the ordering is a tested property rather than a line
/// position in the Windows host.
pub trait ShellHost {
    type Proc: Child;

    /// Tauri's `app.path().resource_dir()`. Not a path relative to the current
    /// directory, which works under `cargo run` and breaks in an installed
    /// build.
    fn resource_dir(&mut self) -> Result<std::path::PathBuf, String>;

    /// Tauri's `app.path().app_local_data_dir()` -- the per-user writable root
    /// under the Windows LOCAL known folder, NOT roaming.
    ///
    /// SEPARATE FROM `resource_dir` BECAUSE THEY ARE DIFFERENT PLACES WITH
    /// DIFFERENT PERMISSIONS, and conflating them is the whole defect: one is
    /// where the installer put the application and the other is where the
    /// person running it is allowed to write.
    fn data_dir(&mut self) -> Result<std::path::PathBuf, String>;

    /// Create the writable directories, or say why not.
    ///
    /// IDEMPOTENT. They exist after the first launch, so "already there" is the
    /// normal answer and must not be an error.
    fn create_directories(&mut self, directories: &WritableDirectories) -> Result<(), String>;

    /// Whether a packaged resource is present.
    ///
    /// ON THE TRAIT RATHER THAN `Path::exists`, because the assembly's job is to
    /// decide what happens when a resource is MISSING, and a test that had to
    /// lay out a fake install tree on disk to reach that branch would be testing
    /// the filesystem. The Windows host answers with `Path::exists`.
    fn resource_exists(&self, path: &std::path::Path) -> bool;

    /// Create the kill-on-close job. Called BEFORE any child exists.
    fn create_job(&mut self) -> Result<(), JobError>;

    fn spawn(&mut self, launch: &SidecarLaunch) -> Result<Self::Proc, String>;

    /// Put the child in the job. A failure here means the caller must kill it.
    fn assign_to_job(&mut self, child: &Self::Proc) -> Result<(), JobError>;

    fn kill(&mut self, child: &mut Self::Proc);

    fn await_handshake(&mut self, child: &mut Self::Proc, within: Duration) -> HandshakeOutcome;

    /// Make the webview present `token` on its requests to `origin`, and to
    /// nowhere else.
    ///
    /// CALLED BEFORE `show_window`, AND THAT ORDER IS LOAD-BEARING. Request
    /// interception applies to requests issued after it is installed, so a
    /// filter added after the navigation does not cover the document request
    /// it was added for. `start_once` orders the two calls and
    /// `the_webview_is_authorized_before_it_is_pointed_at_anything` asserts it.
    ///
    /// SCOPED TO `origin`, AND THAT IS THE SECURITY-RELEVANT LINE OF THE WHOLE
    /// MECHANISM. `origin` comes from the child's own handshake, which
    /// `handshake::parse` has already refused unless the host is a loopback
    /// literal. The implementation must attach the token to that origin and to
    /// nothing else: a filter that matched every URL would hand a per-launch
    /// secret to every host the webview ever reached.
    fn authorize_webview(&mut self, origin: &str, token: &str) -> Result<(), String>;

    /// Point the webview at the origin and make the window visible. The window
    /// is created hidden, so this is the only thing that shows it.
    fn show_window(&mut self, origin: &str) -> Result<(), String>;

    /// Tell the user what went wrong, in a window they can read.
    fn surface_failure(&mut self, report: &FailureReport);

    /// Block until the child exits; return how long it ran.
    fn await_exit(&mut self, child: Self::Proc) -> Duration;

    fn sleep(&mut self, duration: Duration);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellOutcome {
    /// The sidecar exited after a window had been shown, and the budget is
    /// spent. Ordinary application shutdown is not this: it is the host
    /// dropping the job.
    Stopped,
    /// It never started. The failure has already been surfaced.
    FailedToStart,
}

/// Start the sidecar, show the window, and keep it alive within the budget.
///
/// `mint` is a parameter so the assembly can be tested without the OS CSPRNG --
/// and, more importantly, so a test can prove that a token which cannot be
/// minted stops the launch instead of producing a weaker one.
pub fn run_shell<H: ShellHost>(
    host: &mut H,
    mint: &dyn Fn() -> Result<String, String>,
) -> ShellOutcome {
    let mut budget = Budget::new();
    let mut shown = false;

    loop {
        match start_once(host, mint) {
            Ok(child) => {
                shown = true;
                let ran_for = host.await_exit(child);
                match budget.record_exit(ran_for) {
                    Decision::Restart { after } => {
                        host.sleep(after);
                        continue;
                    }
                    Decision::GiveUp { attempts } => {
                        host.surface_failure(&describe(&StartupFailure::Unstable { attempts }));
                        return ShellOutcome::Stopped;
                    }
                }
            }
            Err(failure) => {
                /*
                 * A START THAT NEVER REACHED A WINDOW IS CHARGED TO THE BUDGET
                 * LIKE ANY OTHER FAILURE, with a zero-length run, so that a
                 * sidecar which dies during startup is retried exactly as many
                 * times as one that dies immediately after -- and no more. The
                 * two look identical to a user and there is no reason to give
                 * one of them an unbounded loop.
                 */
                match budget.record_exit(Duration::ZERO) {
                    Decision::Restart { after } if !is_permanent(&failure) => {
                        host.sleep(after);
                        continue;
                    }
                    _ => {
                        host.surface_failure(&describe(&failure));
                        return if shown {
                            ShellOutcome::Stopped
                        } else {
                            ShellOutcome::FailedToStart
                        };
                    }
                }
            }
        }
    }
}

/// Whether retrying this failure could conceivably work.
///
/// A missing file will not appear on the fourth attempt, and neither will a
/// broken contract. Retrying them burns the user's time and delays the message
/// that would have told them what to do. `FailureReport.retry_may_help` says the
/// same thing to the user; this says it to the loop, and they are derived from
/// the same match so they cannot disagree.
fn is_permanent(failure: &StartupFailure) -> bool {
    !describe(failure).retry_may_help
}

/// One attempt. Everything here is ordered, and the order is the point.
fn start_once<H: ShellHost>(
    host: &mut H,
    mint: &dyn Fn() -> Result<String, String>,
) -> Result<H::Proc, StartupFailure> {
    let token = mint().map_err(|detail| StartupFailure::Launch(LaunchError::Token(detail)))?;

    let resources = host.resource_dir().map_err(|detail| {
        StartupFailure::Launch(LaunchError::Missing {
            what: "resource directory",
            at: std::path::PathBuf::from(detail),
        })
    })?;

    /*
     * WHERE THE CHILD MAY WRITE, resolved from the platform rather than
     * composed here (PW-0501). An installed build's resource directory is
     * under Program Files and is read-only to the person running it, so a
     * sidecar given nowhere else to write fails on its first cache write --
     * after starting, which is the worst moment to find out.
     */
    let writable_root = host.data_dir().map_err(|detail| {
        StartupFailure::Launch(LaunchError::Missing {
            what: "application data directory",
            at: std::path::PathBuf::from(detail),
        })
    })?;

    let launch = {
        let probe = &*host;
        plan_launch(&resources, &writable_root, &token, &|path| {
            probe.resource_exists(path)
        })
        .map_err(StartupFailure::Launch)?
    };

    /*
     * CREATED BEFORE THE SPAWN, AND A FAILURE HERE REFUSES THE LAUNCH. The
     * alternative -- start anyway and let the child discover it -- is the
     * defect this exists to prevent, one process later and with a worse error.
     * `create_directories` is idempotent: after the first run these all exist,
     * and that is the normal case rather than the exception.
     */
    host.create_directories(&launch.writable)
        .map_err(|detail| StartupFailure::Launch(LaunchError::Unwritable { detail }))?;

    /*
     * THE JOB IS CREATED BEFORE THE CHILD EXISTS, and if it cannot be created
     * the shell REFUSES TO START rather than running unsupervised. That is a
     * deliberate trade: an unsupervised sidecar is the orphaned `node.exe` that
     * holds the loopback port and makes the next launch fail, and a user who is
     * told why nothing opened is better served than one whose machine
     * accumulates background processes.
     */
    host.create_job().map_err(StartupFailure::Supervision)?;

    let mut child = host
        .spawn(&launch)
        .map_err(|detail| StartupFailure::Launch(LaunchError::Token(detail)))?;

    /*
     * ASSIGNED IMMEDIATELY, AND A FAILURE KILLS THE CHILD. There is an
     * unavoidable window between spawn and assign -- `job.rs` records why
     * closing it would trade a microsecond race for a class of hangs -- but a
     * child that is running and NOT in the job is the orphan itself, so it is
     * killed rather than left.
     */
    if let Err(error) = host.assign_to_job(&child) {
        host.kill(&mut child);
        return Err(StartupFailure::Supervision(error));
    }

    match host.await_handshake(&mut child, HANDSHAKE_TIMEOUT) {
        HandshakeOutcome::Ready(ready) => {
            /*
             * THE ORIGIN IS BUILT FROM WHAT THE CHILD REPORTED, never from a
             * port this process chose -- there is no port this process chose.
             * `Handshake::origin` brackets IPv6, and `handshake::parse` has
             * already refused any host that is not loopback.
             */
            let origin = ready.origin();
            /*
             * BEFORE THE NAVIGATION, NOT AFTER IT. The page the webview is
             * about to load is refused unless it presents the token this
             * launch minted, and a request interceptor installed after the
             * document request has gone out does not apply to it. A failure
             * here is a startup failure rather than something to carry on
             * past: carrying on would open the window on a 403 with no
             * explanation, which is the exact state this step exists to end.
             */
            if let Err(detail) = host.authorize_webview(&origin, &token) {
                host.kill(&mut child);
                return Err(StartupFailure::BadHandshake(detail));
            }
            if let Err(detail) = host.show_window(&origin) {
                host.kill(&mut child);
                return Err(StartupFailure::BadHandshake(detail));
            }
            Ok(child)
        }
        HandshakeOutcome::Rejected(reason) => {
            host.kill(&mut child);
            Err(StartupFailure::BadHandshake(reason))
        }
        HandshakeOutcome::ChildExited => {
            Err(StartupFailure::NoHandshake { waited_seconds: 0 })
        }
        HandshakeOutcome::TimedOut => {
            host.kill(&mut child);
            Err(StartupFailure::NoHandshake {
                waited_seconds: HANDSHAKE_TIMEOUT.as_secs(),
            })
        }
    }
}

/// Classify one line of the child's output.
///
/// Re-exported through this module so the Windows host reads lines and asks
/// here, rather than each host re-deciding what counts as a handshake.
pub fn classify_line(line: &str) -> Option<HandshakeOutcome> {
    match handshake::parse(line) {
        Ok(ready) => Some(HandshakeOutcome::Ready(ready)),
        Err(HandshakeError::NotHandshake) => None,
        Err(HandshakeError::Malformed(reason)) => Some(HandshakeOutcome::Rejected(reason)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::PathBuf;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Call {
        ResourceDir,
        DataDir,
        CreateDirectories(Vec<PathBuf>),
        CreateJob,
        Spawn { args: Vec<String>, env: Vec<(String, String)> },
        Assign,
        Kill,
        AwaitHandshake,
        AuthorizeWebview { origin: String, token: String },
        ShowWindow(String),
        SurfaceFailure(String),
        AwaitExit,
        Sleep,
    }

    struct FakeProc;
    impl Child for FakeProc {}

    struct Fake {
        calls: RefCell<Vec<Call>>,
        authorize: Result<(), String>,
        resource_dir: Result<PathBuf, String>,
        data_dir: Result<PathBuf, String>,
        create_directories: Result<(), String>,
        create_job: Result<(), JobError>,
        assign: Result<(), JobError>,
        handshakes: RefCell<Vec<HandshakeOutcome>>,
        show: Result<(), String>,
        runs: RefCell<Vec<Duration>>,
        spawn_ok: bool,
        resources_present: bool,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                resource_dir: Ok(PathBuf::from("C:\\Liberty")),
                data_dir: Ok(PathBuf::from("C:\\Users\\viewer\\AppData\\Local\\Liberty")),
                create_directories: Ok(()),
                create_job: Ok(()),
                assign: Ok(()),
                handshakes: RefCell::new(vec![HandshakeOutcome::Ready(Handshake {
                    host: "127.0.0.1".into(),
                    port: 41999,
                })]),
                authorize: Ok(()),
                show: Ok(()),
                runs: RefCell::new(vec![Duration::from_secs(3600)]),
                spawn_ok: true,
                resources_present: true,
            }
        }
        fn calls(&self) -> Vec<Call> {
            self.calls.borrow().clone()
        }
        fn names(&self) -> Vec<&'static str> {
            self.calls()
                .iter()
                .map(|c| match c {
                    Call::ResourceDir => "resource_dir",
                    Call::DataDir => "data_dir",
                    Call::CreateDirectories(_) => "create_directories",
                    Call::CreateJob => "create_job",
                    Call::Spawn { .. } => "spawn",
                    Call::Assign => "assign",
                    Call::Kill => "kill",
                    Call::AwaitHandshake => "await_handshake",
                    Call::AuthorizeWebview { .. } => "authorize_webview",
                    Call::ShowWindow(_) => "show_window",
                    Call::SurfaceFailure(_) => "surface_failure",
                    Call::AwaitExit => "await_exit",
                    Call::Sleep => "sleep",
                })
                .collect()
        }
    }

    impl ShellHost for Fake {
        type Proc = FakeProc;

        fn resource_dir(&mut self) -> Result<PathBuf, String> {
            self.calls.borrow_mut().push(Call::ResourceDir);
            self.resource_dir.clone()
        }
        fn data_dir(&mut self) -> Result<PathBuf, String> {
            self.calls.borrow_mut().push(Call::DataDir);
            self.data_dir.clone()
        }
        fn create_directories(&mut self, directories: &WritableDirectories) -> Result<(), String> {
            self.calls.borrow_mut().push(Call::CreateDirectories(
                directories.all().iter().map(|p| p.to_path_buf()).collect(),
            ));
            self.create_directories.clone()
        }
        fn resource_exists(&self, _path: &std::path::Path) -> bool {
            self.resources_present
        }
        fn create_job(&mut self) -> Result<(), JobError> {
            self.calls.borrow_mut().push(Call::CreateJob);
            self.create_job.clone()
        }
        fn spawn(&mut self, launch: &SidecarLaunch) -> Result<FakeProc, String> {
            self.calls.borrow_mut().push(Call::Spawn {
                args: crate::sidecar::launch_arguments(launch),
                env: launch.env.clone(),
            });
            if self.spawn_ok {
                Ok(FakeProc)
            } else {
                Err("spawn refused".into())
            }
        }
        fn assign_to_job(&mut self, _child: &FakeProc) -> Result<(), JobError> {
            self.calls.borrow_mut().push(Call::Assign);
            self.assign.clone()
        }
        fn kill(&mut self, _child: &mut FakeProc) {
            self.calls.borrow_mut().push(Call::Kill);
        }
        fn await_handshake(&mut self, _child: &mut FakeProc, _within: Duration) -> HandshakeOutcome {
            self.calls.borrow_mut().push(Call::AwaitHandshake);
            let mut queued = self.handshakes.borrow_mut();
            if queued.len() > 1 {
                queued.remove(0)
            } else {
                queued[0].clone()
            }
        }
        fn authorize_webview(&mut self, origin: &str, token: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(Call::AuthorizeWebview {
                origin: origin.to_string(),
                token: token.to_string(),
            });
            self.authorize.clone()
        }

        fn show_window(&mut self, origin: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(Call::ShowWindow(origin.to_string()));
            self.show.clone()
        }
        fn surface_failure(&mut self, report: &FailureReport) {
            self.calls
                .borrow_mut()
                .push(Call::SurfaceFailure(format!("{} :: {}", report.headline, report.detail)));
        }
        fn await_exit(&mut self, _child: FakeProc) -> Duration {
            self.calls.borrow_mut().push(Call::AwaitExit);
            let mut runs = self.runs.borrow_mut();
            if runs.is_empty() {
                /*
                 * ONCE THE SCRIPTED RUNS ARE SPENT, EVERY FURTHER RUN FLAPS, so
                 * the loop reaches its budget and returns.
                 *
                 * The first draft of this fake repeated its last value forever,
                 * and with a healthy value that is an infinite loop -- the whole
                 * suite was SIGKILLed. That is not a defect in `run_shell`: a
                 * sidecar that runs for an hour and exits SHOULD be restarted,
                 * and `Budget::record_exit` clearing on a healthy run is the
                 * documented behaviour. It is a defect in a fake that could
                 * promise an endless supply of healthy runs, which no real
                 * machine does.
                 */
                return Duration::from_millis(1);
            }
            runs.remove(0)
        }
        fn sleep(&mut self, _duration: Duration) {
            self.calls.borrow_mut().push(Call::Sleep);
        }
    }

    fn mint_ok() -> Result<String, String> {
        Ok(TOKEN.to_string())
    }

    #[test]
    fn the_job_exists_before_the_child_and_the_child_is_assigned_before_anything_else() {
        // THE CENTRAL ORDERING ASSERTION. A job created after the spawn has
        // nothing to assign; a child left unassigned IS the orphan this whole
        // design exists to prevent. Both are ordering properties, and ordering
        // is exactly what can be proved without Windows.
        let mut fake = Fake::new();
        let _ = run_shell(&mut fake, &mint_ok);

        let names = fake.names();
        let create = names.iter().position(|n| *n == "create_job").unwrap();
        let spawn = names.iter().position(|n| *n == "spawn").unwrap();
        let assign = names.iter().position(|n| *n == "assign").unwrap();
        let handshake = names.iter().position(|n| *n == "await_handshake").unwrap();
        let show = names.iter().position(|n| *n == "show_window").unwrap();

        assert!(create < spawn, "the job must exist before the child: {names:?}");
        assert!(spawn < assign, "{names:?}");
        assert!(assign < handshake, "assignment must not wait on the handshake: {names:?}");
        assert!(handshake < show, "the window must not be shown before a handshake: {names:?}");
    }

    #[test]
    fn the_token_never_reaches_the_spawn_arguments() {
        // The same property `sidecar.rs` asserts about `launch_arguments`,
        // re-asserted at the point where a process is actually created --
        // because that is where somebody would one day add an argument.
        let mut fake = Fake::new();
        let _ = run_shell(&mut fake, &mint_ok);

        let spawn = fake
            .calls()
            .into_iter()
            .find_map(|c| match c {
                Call::Spawn { args, env } => Some((args, env)),
                _ => None,
            })
            .expect("a spawn");
        assert!(spawn.0.iter().all(|a| !a.contains(TOKEN)), "{:?}", spawn.0);
        assert!(
            spawn.1.iter().any(|(name, value)| name == "LIBERTY_SIDECAR_TOKEN" && value == TOKEN),
            "the token must travel in the environment"
        );
    }

    #[test]
    fn the_webview_is_authorized_before_it_is_pointed_at_anything() {
        /*
         * THE ORDER IS THE WHOLE PROPERTY. `apps/web/src/proxy.ts` refuses
         * every request that does not carry `x-liberty-sidecar-token`, and its
         * matcher excludes only Next's immutable static output -- so the
         * DOCUMENT request is refused too. WebView2's request interception
         * applies to requests issued after it is installed, so an interceptor
         * added after the navigation does not cover the navigation. Before
         * this step existed the window opened on a 403 with no body.
         */
        let mut fake = Fake::new();
        assert_eq!(run_shell(&mut fake, &mint_ok), ShellOutcome::Stopped);

        let names = fake.names();
        let authorize = names
            .iter()
            .position(|n| *n == "authorize_webview")
            .unwrap_or_else(|| panic!("the webview was never authorized: {names:?}"));
        let show = names
            .iter()
            .position(|n| *n == "show_window")
            .unwrap_or_else(|| panic!("the window was never shown: {names:?}"));
        assert!(
            authorize < show,
            "the webview must be authorized before it is navigated: {names:?}"
        );
    }

    #[test]
    fn the_webview_is_authorized_for_the_origin_the_child_reported_and_with_the_minted_token() {
        /*
         * NOT A GUESS AND NOT A CONSTANT. The origin comes from the child's own
         * handshake -- there is no port this process chose -- and the token is
         * the one this launch minted. An implementation that authorized some
         * other origin would be handing a per-launch secret to a host the
         * child never named, which is the one thing the scoping exists to
         * prevent.
         */
        let mut fake = Fake::new();
        assert_eq!(run_shell(&mut fake, &mint_ok), ShellOutcome::Stopped);

        let (origin, token) = fake
            .calls()
            .into_iter()
            .find_map(|c| match c {
                Call::AuthorizeWebview { origin, token } => Some((origin, token)),
                _ => None,
            })
            .expect("the webview was authorized");

        // The Fake's handshake reports 127.0.0.1:41999.
        assert_eq!(origin, "http://127.0.0.1:41999");
        assert_eq!(token, mint_ok().expect("a token"));

        // And the same origin is the one navigated to, so the authorization
        // cannot be scoped to somewhere the navigation does not go.
        let shown = fake
            .calls()
            .into_iter()
            .find_map(|c| match c {
                Call::ShowWindow(url) => Some(url),
                _ => None,
            })
            .expect("the window was shown");
        assert_eq!(shown, origin);
    }

    #[test]
    fn a_webview_that_cannot_be_authorized_refuses_to_start_rather_than_showing_a_refusal() {
        /*
         * Carrying on would open the window on a 403 with no body, which is
         * indistinguishable from the application being broken and is what this
         * whole step exists to end. The child is killed rather than left
         * running behind a window nobody can use.
         */
        let mut fake = Fake::new();
        fake.authorize = Err("the webview could not be reached".into());
        let outcome = run_shell(&mut fake, &mint_ok);

        assert_eq!(outcome, ShellOutcome::FailedToStart);
        let names = fake.names();
        assert!(
            !names.contains(&"show_window"),
            "no window may be shown on an unauthorized webview: {names:?}"
        );
        assert!(names.contains(&"kill"), "the child must be killed: {names:?}");
        assert!(names.contains(&"surface_failure"), "{names:?}");
    }

    #[test]
    fn the_token_still_never_reaches_the_spawn_arguments_now_that_a_method_takes_one() {
        /*
         * `authorize_webview` is the ONE place a token crosses this trait, and
         * adding it must not have loosened the older property beside it. This
         * is deliberately redundant with `the_token_never_reaches_the_spawn_-
         * arguments`: that test guards `spawn`, and this one guards the claim
         * that the new method is the only addition.
         */
        let mut fake = Fake::new();
        assert_eq!(run_shell(&mut fake, &mint_ok), ShellOutcome::Stopped);
        let token = mint_ok().expect("a token");

        for call in fake.calls() {
            match call {
                // The one method that is supposed to have it.
                Call::AuthorizeWebview { .. } => {}
                Call::Spawn { args, env } => {
                    assert!(
                        !args.iter().any(|a| a.contains(&token)),
                        "the token reached argv: {args:?}"
                    );
                    // It DOES belong in the environment; that is how the child
                    // gets it. Asserted positively so a silent removal fails.
                    assert!(
                        env.iter().any(|(_, value)| value == &token),
                        "the child was not given the token at all"
                    );
                }
                Call::CreateDirectories(paths) => assert!(
                    !paths.iter().any(|p| p.to_string_lossy().contains(&token)),
                    "the token reached a path: {paths:?}"
                ),
                Call::ShowWindow(url) => assert!(
                    !url.contains(&token),
                    "the token reached the navigated URL: {url}"
                ),
                Call::SurfaceFailure(text) => assert!(
                    !text.contains(&token),
                    "the token reached a user-visible message: {text}"
                ),
                _ => {}
            }
        }
    }

    #[test]
    fn a_token_that_cannot_be_minted_stops_the_launch() {
        // No fallback. Every weaker source is predictable to the local processes
        // the token exists to exclude, so the shell refuses instead.
        let mut fake = Fake::new();
        let outcome = run_shell(&mut fake, &|| Err("no entropy".into()));

        assert_eq!(outcome, ShellOutcome::FailedToStart);
        let names = fake.names();
        assert!(!names.contains(&"spawn"), "nothing may be spawned: {names:?}");
        assert!(names.contains(&"surface_failure"));
    }

    #[test]
    fn a_job_that_cannot_be_created_refuses_to_start_rather_than_running_unsupervised() {
        // The deliberate trade: no window, with a reason, rather than a
        // background process nothing can stop.
        let mut fake = Fake::new();
        fake.create_job = Err(JobError::Create("GetLastError=5".into()));
        let outcome = run_shell(&mut fake, &mint_ok);

        assert_eq!(outcome, ShellOutcome::FailedToStart);
        let names = fake.names();
        assert!(!names.contains(&"spawn"), "{names:?}");
        let surfaced = fake
            .calls()
            .into_iter()
            .find_map(|c| match c {
                Call::SurfaceFailure(text) => Some(text),
                _ => None,
            })
            .expect("a surfaced failure");
        assert!(surfaced.contains("background process"), "{surfaced}");
    }

    #[test]
    fn a_child_that_cannot_be_assigned_is_killed() {
        // An unassigned running child is the orphan itself. Leaving it is worse
        // than never having started it.
        let mut fake = Fake::new();
        fake.assign = Err(JobError::Assign("GetLastError=5".into()));
        let _ = run_shell(&mut fake, &mint_ok);

        let names = fake.names();
        let assign = names.iter().position(|n| *n == "assign").unwrap();
        let kill = names.iter().position(|n| *n == "kill").expect("the child must be killed");
        assert!(kill > assign, "{names:?}");
        assert!(!names.contains(&"show_window"), "{names:?}");
    }

    #[test]
    fn the_window_is_pointed_at_the_port_the_child_reported() {
        // There is no port this process chose. The origin is built from the
        // handshake, and IPv6 is bracketed so the URL is navigable.
        let mut fake = Fake::new();
        fake.handshakes = RefCell::new(vec![HandshakeOutcome::Ready(Handshake {
            host: "::1".into(),
            port: 50000,
        })]);
        let _ = run_shell(&mut fake, &mint_ok);

        let shown = fake.calls().into_iter().find_map(|c| match c {
            Call::ShowWindow(origin) => Some(origin),
            _ => None,
        });
        assert_eq!(shown.as_deref(), Some("http://[::1]:50000"));
    }

    #[test]
    fn a_rejected_handshake_kills_the_child_and_does_not_retry() {
        // A broken contract will not fix itself on the fourth attempt, and
        // retrying it delays the message that says what actually happened.
        let mut fake = Fake::new();
        fake.handshakes = RefCell::new(vec![HandshakeOutcome::Rejected(
            "handshake host \"0.0.0.0\" is not a loopback address".into(),
        )]);
        let outcome = run_shell(&mut fake, &mint_ok);

        assert_eq!(outcome, ShellOutcome::FailedToStart);
        assert_eq!(fake.names().iter().filter(|n| **n == "spawn").count(), 1);
        assert!(fake.names().contains(&"kill"));
    }

    #[test]
    fn a_timeout_is_retried_within_the_budget_and_then_surfaced() {
        // A slow first start on a cold disk with an antivirus scanner reading
        // the installation is the case this retries for. It is bounded, and the
        // user is told when the budget is spent.
        let mut fake = Fake::new();
        fake.handshakes = RefCell::new(vec![HandshakeOutcome::TimedOut]);
        let outcome = run_shell(&mut fake, &mint_ok);

        assert_eq!(outcome, ShellOutcome::FailedToStart);
        let spawns = fake.names().iter().filter(|n| **n == "spawn").count();
        assert!(spawns > 1 && spawns <= 6, "bounded retries, got {spawns}");
        assert!(fake.names().contains(&"surface_failure"));
    }

    #[test]
    fn a_healthy_run_that_ends_is_restarted_and_a_flapping_one_is_not() {
        // The supervision policy, exercised through the assembly rather than
        // only in isolation: the loop must actually consult it.
        let mut fake = Fake::new();
        // One healthy hour, then it starts flapping. The healthy run must be
        // restarted; the flapping must eventually stop.
        fake.runs = RefCell::new(vec![Duration::from_secs(3600), Duration::from_millis(10)]);
        let outcome = run_shell(&mut fake, &mint_ok);

        assert_eq!(outcome, ShellOutcome::Stopped);
        assert!(
            fake.names().iter().filter(|n| **n == "spawn").count() > 1,
            "a healthy run that ends must be restarted"
        );
        let surfaced = fake.calls().into_iter().find_map(|c| match c {
            Call::SurfaceFailure(text) => Some(text),
            _ => None,
        });
        assert!(surfaced.unwrap().contains("keeps stopping"));
    }

    #[test]
    fn a_missing_installation_is_not_retried() {
        // `retry_may_help` is false for it, and the loop reads the same answer
        // the user is given, so the two cannot disagree.
        let mut fake = Fake::new();
        fake.resources_present = false;
        let outcome = run_shell(&mut fake, &mint_ok);

        assert_eq!(outcome, ShellOutcome::FailedToStart);
        let names = fake.names();
        assert!(!names.contains(&"spawn"), "{names:?}");
        assert!(!names.contains(&"create_job"), "the plan fails before a job is needed: {names:?}");
    }

    #[test]
    fn no_failure_path_panics_and_every_one_surfaces_something() {
        // "Surface an actionable application failure rather than panic or
        // silently exit" -- asserted over every failure this assembly can
        // produce, because a shell that panics is a window that closes itself.
        type Configure = Box<dyn Fn(&mut Fake)>;
        let cases: Vec<Configure> = vec![
            Box::new(|f: &mut Fake| f.create_job = Err(JobError::Create("x".into()))),
            Box::new(|f: &mut Fake| f.assign = Err(JobError::Assign("x".into()))),
            Box::new(|f: &mut Fake| f.spawn_ok = false),
            Box::new(|f: &mut Fake| {
                f.handshakes = RefCell::new(vec![HandshakeOutcome::TimedOut])
            }),
            Box::new(|f: &mut Fake| {
                f.handshakes = RefCell::new(vec![HandshakeOutcome::ChildExited])
            }),
            Box::new(|f: &mut Fake| {
                f.handshakes = RefCell::new(vec![HandshakeOutcome::Rejected("bad".into())])
            }),
            Box::new(|f: &mut Fake| f.show = Err("webview refused".into())),
            Box::new(|f: &mut Fake| f.resource_dir = Err("no resource dir".into())),
            Box::new(|f: &mut Fake| f.resources_present = false),
        ];

        for (index, configure) in cases.iter().enumerate() {
            let mut fake = Fake::new();
            configure(&mut fake);
            let outcome = run_shell(&mut fake, &mint_ok);
            assert_eq!(outcome, ShellOutcome::FailedToStart, "case {index}");
            assert!(
                fake.names().contains(&"surface_failure"),
                "case {index} surfaced nothing: {:?}",
                fake.names()
            );
        }
    }

    #[test]
    fn classify_line_ignores_ordinary_output_and_reports_a_broken_contract() {
        assert_eq!(classify_line("  ▲ Next.js 16.3.1"), None);
        assert!(matches!(
            classify_line(r#"liberty-sidecar-ready {"host":"127.0.0.1","port":41999}"#),
            Some(HandshakeOutcome::Ready(_))
        ));
        assert!(matches!(
            classify_line(r#"liberty-sidecar-ready {"host":"0.0.0.0","port":41999}"#),
            Some(HandshakeOutcome::Rejected(_))
        ));
    }
}
