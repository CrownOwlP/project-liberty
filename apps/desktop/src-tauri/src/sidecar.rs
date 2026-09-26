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
    /// Name/value pairs, in a stable order so this is testable.
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchError {
    /// The packaged runtime or server is not where the bundle should have put
    /// it. Almost always a broken install or a `bundle.resources` that stopped
    /// matching these constants.
    Missing { what: &'static str, at: PathBuf },
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

    Ok(SidecarLaunch {
        node,
        server,
        env: vec![
            (TOKEN_VAR.to_string(), token.to_string()),
            (HOST_VAR.to_string(), BIND_HOST.to_string()),
            (NODE_HOSTNAME_VAR.to_string(), BIND_HOST.to_string()),
            (NODE_PORT_VAR.to_string(), BIND_PORT.to_string()),
        ],
    })
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
        plan_launch(Path::new("C:\\Program Files\\Liberty"), token, &everything_exists)
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
        match plan_launch(Path::new("C:\\Liberty"), TOKEN, &missing_node) {
            Err(LaunchError::Missing { what, at }) => {
                assert_eq!(what, "Node runtime");
                assert!(at.to_string_lossy().contains("node.exe"));
            }
            other => panic!("expected a missing-runtime error: {other:?}"),
        }

        let missing_server = |path: &Path| !path.to_string_lossy().contains("server.js");
        match plan_launch(Path::new("C:\\Liberty"), TOKEN, &missing_server) {
            Err(LaunchError::Missing { what, .. }) => assert_eq!(what, "application server"),
            other => panic!("expected a missing-server error: {other:?}"),
        }
    }

    #[test]
    fn resources_are_resolved_under_the_directory_they_were_given() {
        // Not relative to the current directory, which works under `cargo run`
        // and breaks in an installed build -- the classic late failure.
        let launch = plan_launch(Path::new("/opt/liberty"), TOKEN, &everything_exists).unwrap();
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
