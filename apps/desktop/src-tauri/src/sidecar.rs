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

/// THE ENTRY POINT IS OURS, NOT NEXT'S (PW-0106).
///
/// This used to be `sidecar/server/server.js`, the entry Next generates for
/// `output: "standalone"`. That file resolves its port as
/// `parseInt(process.env.PORT, 10) || 3000`, and `parseInt("0", 10)` is `0`,
/// which is falsy -- so `BIND_PORT` below, the whole kernel-chooses contract,
/// silently became "bind 3000" with `allowRetry: false`. Observed on the
/// packaged tree as `EADDRINUSE` on 127.0.0.1:3000 and exit 1, which on a
/// user's PC is a first launch with no window.
///
/// `liberty-sidecar.js` is checked in at `apps/desktop/sidecar-bootstrap/`,
/// creates the listener itself on `BIND_HOST` port 0, and hosts the same
/// standalone application through Next's public custom-server API. Next's own
/// entry is still shipped -- it is build output -- and is never spawned;
/// `package-sidecar.mjs` asserts this constant against what it lays down.
pub const SERVER_RELATIVE_PATH: &str = "sidecar/server/liberty-sidecar.js";

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
/// machine doing anything else. `handshake.ts` records the whole argument, and
/// gpt-architect's round-96 ruling restates it as a refusal: "Do NOT replace
/// the kernel-selected-port design with shell-selected/free-port probing."
///
/// IT IS STILL SENT EVEN THOUGH OUR ENTRY POINT NO LONGER READS IT. The value
/// states the launch contract, and `liberty-sidecar.js` implements it by
/// binding a literal 0 rather than by consulting this variable -- deliberately,
/// because consulting it is what produced the defect PW-0106 removed. Sending
/// it keeps the contract legible to anyone reading the spawn, and keeps the
/// environment honest if Next's own entry is ever run by hand for diagnosis.
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
/// Join a `/`-separated relative path onto a root using the PLATFORM
/// separator, one component at a time.
///
/// `Path::join` with `"sidecar/node.exe"` stores that string verbatim, so on
/// Windows the result is `C:\...\Liberty\sidecar/node.exe` -- mixed
/// separators. Win32 tolerates that on an ordinary path because it normalises
/// separators itself, but it does NOT normalise anything under an
/// extended-length `\\?\` prefix, which Microsoft documents: there a forward
/// slash is an ordinary filename character. And Node's module resolver reasons
/// about Windows roots with its own regex rather than through the Win32 parser.
///
/// The constants keep their forward slashes because they are also BUNDLE
/// paths, which `package-sidecar.mjs` asserts against and where a forward
/// slash is correct. The conversion belongs here, at the point the string
/// becomes a filesystem path.
fn join_relative(root: &Path, relative: &str) -> PathBuf {
    /*
     * NO EMPTY-COMPONENT FILTER, AND THAT IS A DELIBERATE DELETION. One was
     * written here first, guarding against a constant later spelled
     * "/sidecar/x" or "sidecar//x". A mutation test then showed that removing
     * it changed nothing: `Path::new("")` is not absolute, so `join("")`
     * cannot discard the root, and it only ever appends a separator that
     * `components()` normalises away. An untestable guard with a confident
     * comment is worse than no guard, so it is gone -- and
     * `an_empty_component_cannot_discard_the_root` locks the behaviour that
     * made it unnecessary.
     */
    relative
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

/// Remove a Windows extended-length prefix from a DRIVE-LETTER path.
///
/// WHY. `\\?\C:\x` and `C:\x` name the same file to Win32, but not to
/// everything that reads a path as a string. Node's `resolveMainPath` resolves
/// the main module through `Module._findPath`, which calls `fs.realpathSync`,
/// which splits the root with
/// `/^(?:[a-zA-Z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)?[\\/]*/` and `lstat`s
/// whatever that matched -- a regex over separators, not a device-path parser.
/// The commander's installed build died in exactly that call.
///
/// THE UNC FORM IS LEFT ALONE, DELIBERATELY. The plain equivalent of
/// `\\?\UNC\server\share` is `\\server\share`, not what you get by
/// deleting four characters, and a prefix removal that produced
/// `UNC\server\share` would silently name something else. A path this does
/// not recognise is returned unchanged, which is the safe direction: at worst
/// it stays as it arrived.
///
/// THE COST, AND IT IS REAL. The prefix exists to escape `MAX_PATH`, and
/// removing it reintroduces that limit for these two paths. Accepted, because
/// Node cannot consume the prefixed form at all -- so the alternative is not a
/// longer path, it is no launch -- and because the installer's own location is
/// far under the limit.
/// The four characters Windows puts in front of a path to switch off
/// normalisation: backslash, backslash, question mark, backslash.
///
/// A named constant because it is the one string in this file that cannot
/// be read at a glance, and because getting it wrong produces a function
/// that silently normalises nothing -- which a test caught here rather
/// than an installed build catching it again.
const EXTENDED_LENGTH_PREFIX: &str = "\\\\?\\";

pub fn without_extended_length_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    let Some(rest) = text.strip_prefix(EXTENDED_LENGTH_PREFIX) else {
        return path.to_path_buf();
    };
    // `C:` and nothing shorter. A drive letter, a colon, then a separator or
    // the end of the string.
    let mut characters = rest.chars();
    let is_drive = matches!(characters.next(), Some(letter) if letter.is_ascii_alphabetic())
        && characters.next() == Some(':')
        && matches!(characters.next(), None | Some('\\') | Some('/'));
    if is_drive {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

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

    /*
     * NORMALISED ONCE, HERE, so every path derived below is plain. Doing it at
     * the two join sites instead would leave the writable roots prefixed, and
     * those become environment variables the child joins paths onto.
     */
    let resource_dir = &without_extended_length_prefix(resource_dir);
    let writable_root = &without_extended_length_prefix(writable_root);

    let node = join_relative(resource_dir, NODE_RELATIVE_PATH);
    if !exists(&node) {
        return Err(LaunchError::Missing {
            what: "Node runtime",
            at: node,
        });
    }
    let server = join_relative(resource_dir, SERVER_RELATIVE_PATH);
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
    let data = join_relative(writable_root, DATA_RELATIVE_PATH);
    let cache = join_relative(writable_root, CACHE_RELATIVE_PATH);
    let logs = join_relative(writable_root, LOG_RELATIVE_PATH);

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

/// Tests that run the ACTUAL Node runtime, not a mock.
///
/// WHY THIS MODULE EXISTS AT ALL. Every ordering and planning test in this
/// crate passed while the installed application could not start: bundled
/// `node.exe` was launched and died resolving its own main script. A mocked
/// `ShellHost` records that `spawn` was called with some argv; it cannot
/// discover that the argv is one Node refuses. So this module hands a real
/// `node` a real script at an installed-style path and asserts it runs.
///
/// IT REQUIRES `node` ON PATH AND SAYS SO LOUDLY IF ABSENT, rather than
/// skipping. `desktop-shell-ci.yml` runs on `windows-latest`, which has Node;
/// a test that quietly passed when the runtime was missing would be the same
/// class of mistake as the one it exists to catch.
#[cfg(test)]
mod real_node {
    use super::*;
    use std::process::Command;

    /// Long enough and hex, so `plan_launch` accepts it. Its own module's
    /// copy is private to that module.
    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// An installed-style directory: spaces in two components, like
    /// `C:\Program Files\Project Liberty`.
    fn script_at_a_spaced_path() -> (tempdir::Guard, PathBuf) {
        let guard = tempdir::Guard::new("liberty sidecar test");
        let nested = guard.path().join("Program Files").join("Project Liberty");
        let server = join_relative(&nested, SERVER_RELATIVE_PATH);
        std::fs::create_dir_all(server.parent().expect("a parent")).expect("create the tree");
        /* The script prints the handshake prefix so this exercises the same
         * contract the shell reads, not merely "node exited 0". */
        std::fs::write(
            &server,
            format!("process.stdout.write('{}' + ' ok\\n');", HANDSHAKE_SENTINEL),
        )
        .expect("write the script");
        (guard, server)
    }

    /// The handshake prefix, duplicated here ON PURPOSE as a literal rather
    /// than imported, so that a change to the real constant has to be made
    /// deliberately in two places instead of silently passing a test that
    /// moved with it.
    const HANDSHAKE_SENTINEL: &str = "liberty-sidecar-ready";

    fn node() -> String {
        std::env::var("LIBERTY_TEST_NODE").unwrap_or_else(|_| "node".to_string())
    }

    fn run(script: &Path) -> Result<std::process::Output, std::io::Error> {
        Command::new(node())
            .arg(script.as_os_str())
            .output()
    }

    #[test]
    fn the_real_node_runs_our_entry_point_from_an_installed_style_path_with_spaces() {
        let (_guard, server) = script_at_a_spaced_path();
        let output = run(&server).unwrap_or_else(|error| {
            panic!(
                "could not run `{}`: {error}. This test needs Node on PATH (or \
                 LIBERTY_TEST_NODE set) -- it exists because a mocked host cannot \
                 discover that a path is one Node refuses.",
                node()
            )
        });
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "node refused the entry point at {}\nstderr: {stderr}",
            server.display()
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(HANDSHAKE_SENTINEL),
            "the script ran but said nothing the shell would recognise"
        );
    }

    #[test]
    fn the_planned_server_path_is_the_one_node_accepts() {
        /*
         * END TO END THROUGH THE PLANNER. Not a hand-built path: the argument
         * is whatever `plan_launch` plus `launch_arguments` would really hand
         * the child, which is the pair that was wrong.
         */
        let (_guard, server) = script_at_a_spaced_path();
        let resources = server
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .expect("the resource root")
            .to_path_buf();
        std::fs::create_dir_all(join_relative(&resources, NODE_RELATIVE_PATH).parent().unwrap())
            .expect("the node directory");
        std::fs::write(join_relative(&resources, NODE_RELATIVE_PATH), b"not a real exe")
            .expect("a stand-in for node.exe, so the existence check passes");

        let launch = plan_launch(&resources, _guard.path(), TOKEN, &|path| path.exists())
            .expect("the plan");
        let arguments = launch_arguments(&launch);
        assert_eq!(arguments.len(), 1, "one argument: {arguments:?}");

        let output = Command::new(node())
            .arg(&arguments[0])
            .output()
            .unwrap_or_else(|error| panic!("could not run `{}`: {error}", node()));
        assert!(
            output.status.success(),
            "node refused the PLANNED path {:?}\nstderr: {}",
            arguments[0],
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// The Windows-only half: the extended-length prefix is what the
    /// commander's build died on, and only Windows can show it.
    #[cfg(windows)]
    #[test]
    fn node_is_given_the_plain_path_and_not_the_extended_length_one() {
        let (_guard, server) = script_at_a_spaced_path();

        /* The prefixed form, built the way Windows itself produces one. */
        let prefixed = PathBuf::from(format!(r"\?\{}", server.display()));
        let plain = without_extended_length_prefix(&prefixed);
        assert_eq!(
            plain, server,
            "the prefix must come off and nothing else may change"
        );

        /* The plain form runs. This is the assertion that matters. */
        let good = run(&plain).unwrap_or_else(|error| panic!("could not run node: {error}"));
        assert!(
            good.status.success(),
            "node refused the normalised path\nstderr: {}",
            String::from_utf8_lossy(&good.stderr)
        );

        /*
         * AND THE PREFIXED FORM IS RECORDED RATHER THAN ASSERTED TO FAIL.
         * The commander's log shows Node failing on a device path, but this
         * test does not claim to know that every Node version on every
         * Windows build refuses every such path -- that would be asserting a
         * third party's bug as a contract. What it does is print the outcome,
         * so a CI log carries the observation; and the assertion above is the
         * property this code actually owns.
         */
        match run(&prefixed) {
            Ok(output) if output.status.success() => {
                println!(
                    "note: this Node accepted the extended-length form too. The fix is still \
                     correct -- it just is not load-bearing on this runtime."
                );
            }
            Ok(output) => println!(
                "note: this Node REFUSED the extended-length form, which is the failure the \
                 installed build hit.\nstderr: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
            Err(error) => println!("note: the prefixed form could not even be spawned: {error}"),
        }
    }

    /// A temporary directory with a name of our choosing, and no dependency
    /// added to a crate that ships.
    mod tempdir {
        pub struct Guard(std::path::PathBuf);

        impl Guard {
            pub fn new(label: &str) -> Self {
                let unique = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                let path = std::env::temp_dir().join(format!("{label} {unique}"));
                std::fs::create_dir_all(&path).expect("a temporary directory");
                Self(path)
            }
            pub fn path(&self) -> &std::path::Path {
                &self.0
            }
        }

        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn an_extended_length_drive_prefix_is_removed_and_nothing_else_is() {
        // The form Windows itself produces, and the form Node's module
        // resolver reasons about with a regex over separators.
        assert_eq!(
            without_extended_length_prefix(Path::new(r"\\?\C:\Program Files\Liberty")),
            PathBuf::from(r"C:\Program Files\Liberty")
        );
        // A bare drive root.
        assert_eq!(
            without_extended_length_prefix(Path::new(r"\\?\C:\")),
            PathBuf::from(r"C:\")
        );
        // Already plain: unchanged, byte for byte.
        assert_eq!(
            without_extended_length_prefix(Path::new(r"C:\Program Files\Liberty")),
            PathBuf::from(r"C:\Program Files\Liberty")
        );
    }

    #[test]
    fn a_unc_extended_length_path_is_left_exactly_as_it_arrived() {
        /*
         * THE ONE THAT WOULD BE A SILENT MISDIRECTION. The plain equivalent of
         * \\?\UNC\server\share is \\server\share, NOT what you get by
         * deleting four characters -- that would be UNC\server\share, a
         * relative path naming something else entirely. Unrecognised forms are
         * returned untouched, which is the safe direction.
         */
        for raw in [
            r"\\?\UNC\fileserver\media\Liberty",
            r"\\?\Volume{b75e2c83-0000-0000-0000-602f00000000}\Liberty",
            r"\\fileserver\media\Liberty",
        ] {
            assert_eq!(
                without_extended_length_prefix(Path::new(raw)),
                PathBuf::from(raw),
                "{raw} must not be rewritten"
            );
        }
    }

    #[test]
    fn a_relative_path_written_with_forward_slashes_is_joined_with_the_platform_separator() {
        /*
         * `Path::join("sidecar/node.exe")` stores that string verbatim, so on
         * Windows the result carries a forward slash into a path Win32 will
         * not normalise under an extended-length prefix. Asserted through
         * `components()` so this means the same thing on both platforms: the
         * relative part must arrive as TWO components, not one.
         */
        let joined = join_relative(Path::new("ROOT"), "sidecar/server/liberty-sidecar.js");
        let tail: Vec<_> = joined
            .components()
            .skip(1)
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        assert_eq!(tail, vec!["sidecar", "server", "liberty-sidecar.js"]);
        /*
         * WINDOWS ONLY, AND THE REASON MATTERS. On Linux `/` IS the platform
         * separator, so asserting its absence would assert the opposite of
         * the property. The platform-independent property is the one above:
         * the relative part arrives as SEPARATE COMPONENTS rather than one
         * filename with slashes in it.
         */
        #[cfg(windows)]
        assert!(
            !joined.to_string_lossy().contains('/'),
            "the forward slash survived into the path: {}",
            joined.display()
        );
    }

    #[test]
    fn an_empty_component_cannot_discard_the_root() {
        /*
         * THE FILTER IN `join_relative` IS NOT DECORATION. `Path::join` with an
         * absolute component REPLACES the path, so a constant someone later
         * writes as "/sidecar/node.exe" would silently resolve against the
         * filesystem root instead of the install directory -- and a doubled
         * slash would leave an empty component behind. A mutation test found
         * that removing the filter was undetected, which made this test the
         * answer rather than the filter being removed.
         */
        for relative in ["/sidecar/node.exe", "sidecar//node.exe", "sidecar/node.exe/"] {
            let joined = join_relative(Path::new("ROOT"), relative);
            let parts: Vec<_> = joined
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            assert_eq!(
                parts,
                vec!["ROOT", "sidecar", "node.exe"],
                "{relative} did not join cleanly: {}",
                joined.display()
            );
        }
    }

    #[test]
    fn the_planned_paths_carry_no_forward_slash_and_no_prefix() {
        // Through the real planner, from a prefixed root, which is what Tauri
        // can hand us.
        let launch = plan_launch(
            Path::new(r"\\?\C:\Program Files\Liberty"),
            Path::new(r"\\?\C:\Users\viewer\AppData\Local\Project Liberty"),
            TOKEN,
            &everything_exists,
        )
        .expect("the plan");

        /*
         * THE PLATFORM-INDEPENDENT HALF, and it is the one that catches a
         * revert to `Path::join`. The forward-slash assertions below only fire
         * on Windows, so on Linux they would let the original defect back in
         * unnoticed -- a mutation test found exactly that. Component counts
         * mean the same thing everywhere.
         */
        let tail: Vec<_> = launch
            .server
            .components()
            .rev()
            .take(3)
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            tail,
            vec!["liberty-sidecar.js", "server", "sidecar"],
            "the relative part must arrive as separate components, not one \
             filename with slashes in it: {}",
            launch.server.display()
        );

        for (what, path) in [
            ("node", &launch.node),
            ("server", &launch.server),
            ("data", &launch.writable.data),
            ("cache", &launch.writable.cache),
            ("logs", &launch.writable.logs),
        ] {
            let text = path.to_string_lossy();
            assert!(
                !text.starts_with(EXTENDED_LENGTH_PREFIX),
                "{what} kept the extended-length prefix: {text}"
            );
            // Windows only, for the reason given in the join test above.
            #[cfg(windows)]
            assert!(
                !text.contains('/'),
                "{what} kept a forward slash: {text}"
            );
        }
        // And the environment the child reads, which is where the writable
        // paths actually travel.
        for (name, value) in &launch.env {
            assert!(
                !value.starts_with(EXTENDED_LENGTH_PREFIX),
                "{name} carries an extended-length prefix: {value}"
            );
            #[cfg(windows)]
            assert!(
                !value.contains('/'),
                "{name} carries a forward slash: {value}"
            );

        }
    }

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
    fn the_shell_spawns_our_bootstrap_and_never_nexts_generated_entry() {
        // THE REGRESSION GUARD FOR PW-0106, on the shell's side of the wire.
        //
        // Next's generated `server.js` cannot honour BIND_PORT: it resolves the
        // port as `parseInt(process.env.PORT, 10) || 3000`, so "0" is falsy and
        // it binds 3000 with retry disabled. Pointing this constant back at it
        // would restore a first-run failure on any machine already using 3000,
        // and would do so silently -- the packaging script would still produce
        // a tree, the installer would still install, and only a user would
        // find out.
        assert!(
            SERVER_RELATIVE_PATH.ends_with("/liberty-sidecar.js"),
            "the spawned entry must be our bootstrap, not Next's: {SERVER_RELATIVE_PATH}"
        );
        assert!(
            !SERVER_RELATIVE_PATH.ends_with("/server.js"),
            "SERVER_RELATIVE_PATH names Next's generated entry, which cannot honour PORT=0"
        );

        let launch = plan(TOKEN).unwrap();
        let spawned = launch.server.to_string_lossy().into_owned();
        assert!(
            spawned.ends_with("liberty-sidecar.js"),
            "the planned launch must spawn the bootstrap: {spawned}"
        );
    }

    #[test]
    fn the_shell_states_a_kernel_chosen_port_and_never_a_number_it_picked() {
        // Acceptance item 12: "no shell-side free-port probing exists." There
        // is nothing to probe WITH in this module -- no socket, no bind, no
        // retry -- so the property is asserted on the one value that could
        // carry a preselected port.
        assert_eq!(
            BIND_PORT, "0",
            "the kernel chooses the port; a concrete number here is a preselection"
        );
        let launch = plan(TOKEN).unwrap();
        let env: std::collections::HashMap<_, _> = launch.env.iter().cloned().collect();
        assert_eq!(env.get(NODE_PORT_VAR).map(String::as_str), Some("0"));
        assert!(
            launch_arguments(&launch)
                .iter()
                .all(|arg| !arg.contains("--port") && !arg.contains("-p")),
            "no port may be passed on the command line either"
        );
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

        // DERIVED FROM THE CONSTANT rather than spelled out. The literal used
        // to be "server.js", and when PW-0106 moved the entry to
        // `liberty-sidecar.js` this predicate silently stopped matching
        // anything -- so the test claimed a missing server and got a valid
        // launch. A test whose subject can rename itself out of the assertion
        // is a test that passes for the wrong reason.
        let server_file = SERVER_RELATIVE_PATH.rsplit('/').next().unwrap();
        let missing_server = |path: &Path| !path.to_string_lossy().contains(server_file);
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
