//! Where the sidecar lives, and what it is started with (PW-0102).
//!
//! WHAT THE SIDECAR IS. A Next.js standalone server, run by a bundled
//! `node.exe`. Not a compiled single file: `pkg`, Node SEA and `bun --compile`
//! were each considered and none of them can swallow a Next standalone tree.
//! The tree is not one entry point -- it is a server plus a `.next` directory
//! the server reads from disk at runtime, including chunk files it resolves by
//! path. A single-file packer produces a binary that starts and then cannot find
//! its own pages. This is recorded so the shortcut is not attempted a second
//! time and abandoned a second time.
//!
//! SO THE LAYOUT IS: `node.exe` plus the standalone tree, both under Tauri's
//! `bundle.resources`, spawned as a child process. Tauri unpacks resources
//! beside the executable, and `app.path().resource_dir()` is the only supported
//! way to find them -- a path relative to the current directory works in `cargo
//! run` and breaks in an installed build, which is the classic way this goes
//! wrong late.
//!
//! THE TOKEN GOES THROUGH THE ENVIRONMENT AND NEVER ON THE COMMAND LINE.
//! On Windows a process's command line is readable by any process running as the
//! same user, through `NtQueryInformationProcess`, and Task Manager will display
//! it in a column. The environment block is not enumerable across processes in
//! the same way. PW-0101 made the token the thing that separates this
//! application's listener from every other process on the machine; putting it in
//! `argv` would publish it to all of them.

use std::path::{Path, PathBuf};

/// Where the packaged runtime and server live inside the resource directory.
///
/// Constants rather than literals at the call sites, because these paths are
/// also what `tauri.conf.json`'s `bundle.resources` has to name, and two
/// spellings of one path is a build that ships a tree the shell cannot find.
pub const NODE_RELATIVE_PATH: &str = "sidecar/node.exe";
pub const SERVER_RELATIVE_PATH: &str = "sidecar/server/server.js";

/// Environment variables the sidecar reads.
///
/// These MUST match `apps/web/src/lib/sidecar/policy.ts`, which is the consumer.
/// They are restated here for the same reason the handshake parser is: there is
/// no artefact a Rust binary and a TypeScript module can share.
pub const TOKEN_VAR: &str = "LIBERTY_SIDECAR_TOKEN";
pub const HOST_VAR: &str = "LIBERTY_SIDECAR_HOST";
pub const NODE_HOSTNAME_VAR: &str = "HOSTNAME";
pub const NODE_PORT_VAR: &str = "PORT";

/* -------------------------------------------------------------------------
 * WHERE THE SIDECAR MAY WRITE (PW-0501)
 *
 * THE DEFECT THIS EXISTS TO PREVENT, and it is not hypothetical: an installed
 * build lives under `C:\Program Files`, which is READ-ONLY to a normal user.
 * The sidecar is a Next standalone server, and a Next server writes a cache at
 * runtime -- `.next/cache`, beside `server.js`, which is inside the resource
 * directory. Nothing above has ever told it otherwise, so the first
 * cache write in an installed build is an EACCES from a directory the
 * installer created, and the symptom is a server that starts and then fails on
 * a request rather than one that fails to start.
 *
 * `cargo run` never sees it, because the resource directory is then the
 * developer's own checkout and is writable. That is exactly the shape of
 * defect `resource_dir()` already carries a comment about: it works in
 * development and breaks in an installed build.
 *
 * THREE DIRECTORIES, NOT ONE, because Windows distinguishes them and so does a
 * person trying to clear one:
 *
 *   - DATA is state the application must not lose. Roaming would follow a user
 *     between machines on a domain, which for a media cache and a local
 *     database would be a surprise measured in gigabytes, so this is LOCAL.
 *   - CACHE is state that may be deleted at any moment, by a disk-cleanup tool
 *     or by a user who wants the space back. Nothing here may assume it
 *     survives.
 *   - LOGS are what a person is asked to send when something goes wrong, so
 *     they need a path that can be said out loud over the phone.
 *
 * THEY ARE DERIVED FROM ONE ROOT the host supplies rather than composed here
 * from `%LOCALAPPDATA%`. Reading the variable in this module would make the
 * layout depend on an environment this process does not control, and Tauri
 * already resolves the known folder properly through `app.path()`. What this
 * module owns is the SHAPE under that root, which is the part the sidecar and
 * the shell must agree on.
 * ---------------------------------------------------------------------- */

/// Where application state that must survive goes, under the host's data root.
pub const DATA_RELATIVE_PATH: &str = "data";
/// Where deletable state goes. Assume it is gone on every start.
pub const CACHE_RELATIVE_PATH: &str = "cache";
/// Where the logs a person is asked to send go.
pub const LOG_RELATIVE_PATH: &str = "logs";

/// The variables the sidecar reads to find them.
///
/// NAMED IN THIS PROJECT'S OWN NAMESPACE rather than borrowed from Next, so a
/// future change to how the server uses them is a change in one application
/// rather than a dependence on a framework's internal variable staying put.
pub const DATA_DIR_VAR: &str = "LIBERTY_SIDECAR_DATA_DIR";
pub const CACHE_DIR_VAR: &str = "LIBERTY_SIDECAR_CACHE_DIR";
pub const LOG_DIR_VAR: &str = "LIBERTY_SIDECAR_LOG_DIR";

/// Next's own cache location, pointed at the cache directory above.
///
/// THE ONE BORROWED NAME, and it is borrowed because it is the variable the
/// framework actually reads: `NEXT_CACHE_DIR` is what moves the incremental
/// cache off `.next/cache`. Setting our own name beside it would be a variable
/// nobody reads and a cache still being written into Program Files.
pub const NEXT_CACHE_DIR_VAR: &str = "NEXT_CACHE_DIR";

/// The host the sidecar is told to bind.
///
/// `127.0.0.1` and not `localhost`: a name is resolved, and on Windows it can
/// resolve to either family or, with a hosts-file entry, to something else. The
/// bind must be unambiguous.
pub const BIND_HOST: &str = "127.0.0.1";

/// Port 0 means "the kernel picks, and the sidecar reports what it got".
///
/// The alternative -- the shell picks a free port and passes it in -- has a
/// TOCTOU window between the pick and the bind that is not theoretical on a
/// machine doing anything else. `handshake.ts` records the whole argument.
pub const BIND_PORT: &str = "0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarLaunch {
    pub node: PathBuf,
    pub server: PathBuf,
    /// Where the child may write. Published on the launch so the host can
    /// create them without recomputing the layout from the root.
    pub writable: WritableDirectories,
    /// Name/value pairs, in a stable order so this is testable.
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchError {
    /// The packaged runtime or server is not where the bundle should have put
    /// it. Almost always a broken install or a `bundle.resources` that stopped
    /// matching these constants.
    Missing { what: &'static str, at: PathBuf },
    /// A directory the child must be able to write could not be created.
    ///
    /// ITS OWN VARIANT, not a `Missing`. "The install is broken" and "this
    /// user cannot write to their own profile" are different events with
    /// different remedies -- reinstall against ask an administrator -- and the
    /// failure text a person is shown is built from this distinction.
    Unwritable { detail: String },
    /// The token this launch would have used is not usable.
    Token(String),
}

impl std::fmt::Display for LaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LaunchError::Missing { what, at } => write!(
                f,
                "the packaged {what} is missing at {}; the installation is incomplete",
                at.display()
            ),
            LaunchError::Unwritable { detail } => write!(
                f,
                "a directory this application must be able to write could not be created: {detail}"
            ),
            LaunchError::Token(detail) => write!(f, "the launch token is unusable: {detail}"),
        }
    }
}

/// The minimum token length, in hex characters.
///
/// Must equal `SIDECAR_TOKEN_MIN_CHARS` in `policy.ts`, which derives it as 32
/// bytes of CSPRNG output hex-encoded. Checked HERE as well as there because
/// this process is the one that mints it: discovering at the sidecar's bind
/// check that the shell generated something too short would be a failure
/// reported by the wrong half of the system.
pub const TOKEN_MIN_CHARS: usize = 64;

/// Build the launch description for a given resource directory and token.
///
/// PURE, AND IT DOES NOT SPAWN. Everything here is path arithmetic and an
/// environment map, which is what makes the token placement and the resource
/// layout testable on a machine that cannot run the thing being launched.
///
/// `exists` is injected so the existence checks can be exercised without laying
/// out a fake install tree. In production it is `Path::exists`.
pub fn plan_launch(
    resource_dir: &Path,
    writable_root: &Path,
    token: &str,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<SidecarLaunch, LaunchError> {
    if token.len() < TOKEN_MIN_CHARS {
        return Err(LaunchError::Token(format!(
            "{} characters; at least {TOKEN_MIN_CHARS} are required",
            token.len()
        )));
    }
    if !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(LaunchError::Token(
            "must be hex-encoded CSPRNG output".into(),
        ));
    }

    let node = resource_dir.join(NODE_RELATIVE_PATH);
    if !exists(&node) {
        return Err(LaunchError::Missing {
            what: "Node runtime",
            at: node,
        });
    }
    let server = resource_dir.join(SERVER_RELATIVE_PATH);
    if !exists(&server) {
        return Err(LaunchError::Missing {
            what: "application server",
            at: server,
        });
    }

    /*
     * THE WRITABLE ROOT IS NOT PROBED FOR EXISTENCE, and that asymmetry with
     * the two resources above is deliberate. A missing `node.exe` means the
     * install is broken and there is nothing to do but say so; a missing data
     * directory means the application has not run yet, which is the normal
     * state on a first launch. Creating it is `create_writable_directories`'
     * job, called by the host before the spawn -- this function stays pure.
     */
    let data = writable_root.join(DATA_RELATIVE_PATH);
    let cache = writable_root.join(CACHE_RELATIVE_PATH);
    let logs = writable_root.join(LOG_RELATIVE_PATH);

    Ok(SidecarLaunch {
        node,
        server,
        env: vec![
            (TOKEN_VAR.to_string(), token.to_string()),
            (HOST_VAR.to_string(), BIND_HOST.to_string()),
            (NODE_HOSTNAME_VAR.to_string(), BIND_HOST.to_string()),
            (NODE_PORT_VAR.to_string(), BIND_PORT.to_string()),
            (DATA_DIR_VAR.to_string(), path_string(&data)),
            (CACHE_DIR_VAR.to_string(), path_string(&cache)),
            (LOG_DIR_VAR.to_string(), path_string(&logs)),
            /* The same directory under the name the framework reads. One
             * location, two names, because one of the readers is not ours. */
            (NEXT_CACHE_DIR_VAR.to_string(), path_string(&cache)),
        ],
        writable: WritableDirectories { data, cache, logs },
    })
}

/// A path as an environment value.
///
/// `to_string_lossy` rather than `to_str().unwrap()`: a Windows path is UTF-16
/// and a user name can contain a surrogate that does not round-trip, and a
/// shell that PANICKED on such a profile would be unreachable for exactly the
/// people who cannot change their user name. A lossy path fails later, in the
/// open, with a path in the message.
fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The three directories the host must create before the child starts.
///
/// RETURNED RATHER THAN CREATED HERE, for the reason this whole module is pure:
/// `plan_launch` is testable on a machine that cannot run the thing it plans,
/// and a function that made directories would need a real filesystem or a
/// fourth injected capability to stay that way. The host creates them; this
/// says which.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WritableDirectories {
    pub data: PathBuf,
    pub cache: PathBuf,
    pub logs: PathBuf,
}

impl WritableDirectories {
    /// In creation order, which is arbitrary -- they are siblings.
    pub fn all(&self) -> [&Path; 3] {
        [&self.data, &self.cache, &self.logs]
    }
}

/// The arguments the child is given.
///
/// THE TOKEN IS NOT AMONG THEM, and the test below asserts it. One path, so
/// there is one place to check.
pub fn launch_arguments(launch: &SidecarLaunch) -> Vec<String> {
    vec![launch.server.to_string_lossy().into_owned()]
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn everything_exists(_: &Path) -> bool {
        true
    }

    fn plan(token: &str) -> Result<SidecarLaunch, LaunchError> {
        plan_launch(
            Path::new("C:\\Program Files\\Liberty"),
            Path::new("C:\\Users\\viewer\\AppData\\Local\\Project Liberty"),
            token,
            &everything_exists,
        )
    }

    #[test]
    fn the_token_travels_in_the_environment_and_never_in_argv() {
        // THE CENTRAL SECURITY ASSERTION OF THIS MODULE. A Windows process's
        // command line is readable by any process running as the same user and
        // is shown in Task Manager; the environment block is not enumerable the
        // same way. PW-0101 made this token the thing that separates our
        // listener from every other local process.
        let launch = plan(TOKEN).unwrap();
        let args = launch_arguments(&launch);

        assert!(
            args.iter().all(|arg| !arg.contains(TOKEN)),
            "the token must not appear in any argument: {args:?}"
        );
        assert_eq!(
            launch
                .env
                .iter()
                .find(|(name, _)| name == TOKEN_VAR)
                .map(|(_, value)| value.as_str()),
            Some(TOKEN)
        );
    }

    #[test]
    fn the_sidecar_is_told_to_bind_loopback_on_a_kernel_chosen_port() {
        let launch = plan(TOKEN).unwrap();
        let env: std::collections::HashMap<_, _> = launch.env.iter().cloned().collect();

        assert_eq!(env.get(HOST_VAR).map(String::as_str), Some("127.0.0.1"));
        assert_eq!(
            env.get(NODE_HOSTNAME_VAR).map(String::as_str),
            Some("127.0.0.1"),
            "Next reads HOSTNAME, and policy.ts refuses to bind when it is unset"
        );
        // Port 0, so the sidecar binds first and reports what it got. The shell
        // never picks a port; see handshake.rs.
        assert_eq!(env.get(NODE_PORT_VAR).map(String::as_str), Some("0"));
    }

    #[test]
    fn a_short_or_non_hex_token_is_refused_before_anything_is_spawned() {
        // Checked here as well as in policy.ts because this process MINTS it.
        // Learning at the sidecar's bind check that the shell generated rubbish
        // would put the failure in the wrong half of the system.
        match plan("0123") {
            Err(LaunchError::Token(detail)) => assert!(detail.contains("64")),
            other => panic!("a short token must be refused: {other:?}"),
        }
        match plan("zzzz0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab") {
            Err(LaunchError::Token(_)) => {}
            other => panic!("a non-hex token must be refused: {other:?}"),
        }
    }

    #[test]
    fn a_missing_runtime_names_what_is_missing_and_where() {
        // "The installation is incomplete" with no path is a support ticket
        // nobody can act on.
        let missing_node = |path: &Path| !path.to_string_lossy().contains("node.exe");
        match plan_launch(Path::new("C:\\Liberty"), Path::new("C:\\State"), TOKEN, &missing_node) {
            Err(LaunchError::Missing { what, at }) => {
                assert_eq!(what, "Node runtime");
                assert!(at.to_string_lossy().contains("node.exe"));
            }
            other => panic!("expected a missing-runtime error: {other:?}"),
        }

        let missing_server = |path: &Path| !path.to_string_lossy().contains("server.js");
        match plan_launch(Path::new("C:\\Liberty"), Path::new("C:\\State"), TOKEN, &missing_server) {
            Err(LaunchError::Missing { what, .. }) => assert_eq!(what, "application server"),
            other => panic!("expected a missing-server error: {other:?}"),
        }
    }

    #[test]
    fn nothing_writable_is_under_the_resource_directory() {
        /*
         * THE DEFECT THIS WHOLE FEATURE EXISTS TO PREVENT, asserted as the
         * relationship rather than as a path (PW-0501).
         *
         * An installed build's resource directory is under `C:\Program Files`,
         * which is read-only to the person running it. A Next standalone
         * server writes an incremental cache at runtime, and with nowhere else
         * to put it that cache lands in `.next/cache` BESIDE `server.js` --
         * inside the read-only tree. The server starts, and then fails on a
         * request, which is the worst moment to discover a permissions
         * problem.
         *
         * `cargo run` never sees it, because the resource directory is then
         * the developer's own checkout. That is exactly the shape of defect
         * `resource_dir()` already carries a warning about.
         */
        let resources = Path::new("C:\\Program Files\\Project Liberty");
        let writable = Path::new("C:\\Users\\viewer\\AppData\\Local\\Project Liberty");
        let launch = plan_launch(resources, writable, TOKEN, &everything_exists).unwrap();

        for directory in launch.writable.all() {
            assert!(
                !directory.starts_with(resources),
                "{directory:?} is inside the resource directory, which an installed build \
                 cannot write to"
            );
            assert!(
                directory.starts_with(writable),
                "{directory:?} is not under the writable root the host resolved"
            );
        }
    }

    #[test]
    fn the_three_directories_are_distinct_and_named_for_what_they_hold() {
        /*
         * DISTINCT, because they have different lifetimes and a person clears
         * them separately: a disk-cleanup tool may delete the cache at any
         * moment, the data must survive that, and the logs are what somebody
         * is asked to send when neither worked. One directory for all three
         * would mean clearing the cache discards the state.
         */
        let launch = plan_launch(
            Path::new("C:\\Liberty"),
            Path::new("C:\\State"),
            TOKEN,
            &everything_exists,
        )
        .unwrap();

        let all = launch.writable.all();
        for (index, directory) in all.iter().enumerate() {
            for other in &all[index + 1..] {
                assert_ne!(directory, other, "two of the writable directories are the same path");
            }
        }

        assert!(launch.writable.data.ends_with(DATA_RELATIVE_PATH));
        assert!(launch.writable.cache.ends_with(CACHE_RELATIVE_PATH));
        assert!(launch.writable.logs.ends_with(LOG_RELATIVE_PATH));
    }

    #[test]
    fn the_child_is_told_where_to_write_in_its_environment() {
        /*
         * IN THE ENVIRONMENT AND NOT ON THE COMMAND LINE, for the reason the
         * token is: `launch_arguments` is one path and is asserted to carry
         * one thing. A directory on a command line is not a secret, but two
         * channels for the same kind of configuration is how the token ends up
         * on the second one.
         *
         * AND THE FRAMEWORK'S OWN NAME IS SET TOO. `NEXT_CACHE_DIR` is what
         * actually moves Next's incremental cache; a Liberty-namespaced
         * variable alone would be read by nobody and the cache would still be
         * written into Program Files. One directory, two names, because one of
         * the readers is not ours.
         */
        let launch = plan_launch(
            Path::new("C:\\Liberty"),
            Path::new("C:\\State"),
            TOKEN,
            &everything_exists,
        )
        .unwrap();
        let env: std::collections::HashMap<_, _> = launch.env.iter().cloned().collect();

        assert_eq!(
            env.get(DATA_DIR_VAR).map(String::as_str),
            Some(launch.writable.data.to_string_lossy().as_ref())
        );
        assert_eq!(
            env.get(CACHE_DIR_VAR).map(String::as_str),
            Some(launch.writable.cache.to_string_lossy().as_ref())
        );
        assert_eq!(
            env.get(LOG_DIR_VAR).map(String::as_str),
            Some(launch.writable.logs.to_string_lossy().as_ref())
        );
        assert_eq!(
            env.get(NEXT_CACHE_DIR_VAR),
            env.get(CACHE_DIR_VAR),
            "the framework's cache variable and ours must name ONE directory"
        );

        /* Not on the command line. */
        let args = launch_arguments(&launch);
        for directory in launch.writable.all() {
            let rendered = directory.to_string_lossy().into_owned();
            assert!(!args.iter().any(|arg| arg.contains(&rendered)));
        }
    }

    #[test]
    fn a_missing_writable_root_is_not_a_broken_installation() {
        /*
         * THE ASYMMETRY WITH THE RESOURCE CHECKS, stated as a test because it
         * looks like an omission otherwise. A missing `node.exe` means the
         * install is broken; a missing data directory means the application
         * has not run yet, which is the normal state of a first launch. So
         * `exists` is not consulted for the writable root, and planning
         * succeeds against a root that is not there -- the host creates it
         * before the spawn.
         */
        let nothing_writable_exists =
            |path: &Path| !path.to_string_lossy().contains("brand-new-profile");

        let launch = plan_launch(
            Path::new("C:\\Liberty"),
            Path::new("C:\\Users\\brand-new-profile\\AppData\\Local\\Liberty"),
            TOKEN,
            &nothing_writable_exists,
        )
        .expect("a first launch must plan successfully against a profile that has no state yet");

        assert!(launch.writable.data.to_string_lossy().contains("brand-new-profile"));
    }

    #[test]
    fn resources_are_resolved_under_the_directory_they_were_given() {
        // Not relative to the current directory, which works under `cargo run`
        // and breaks in an installed build -- the classic late failure.
        let launch =
            plan_launch(Path::new("/opt/liberty"), Path::new("/var/liberty"), TOKEN, &everything_exists)
                .unwrap();
        assert!(launch.node.starts_with("/opt/liberty"));
        assert!(launch.server.starts_with("/opt/liberty"));
    }

    #[test]
    fn the_error_display_never_repeats_the_token() {
        // A launch error is logged. The token is the credential.
        let error = plan("0123").unwrap_err().to_string();
        assert!(!error.contains(TOKEN));
    }
}
