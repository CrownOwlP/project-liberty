//! What the sidecar said, kept where somebody can read it (PL-0734).
//!
//! ==========================================================================
//! THE DEFECT THIS CLOSES
//! ==========================================================================
//!
//! The shell created `%LOCALAPPDATA%\<identifier>\logs` at first launch and
//! handed it to the sidecar as `LIBERTY_SIDECAR_LOG_DIR`, and **nothing ever
//! wrote into it**. No `File::create`, no `write_all`, no `fs::write`
//! anywhere in this crate; no `log` or `tracing` dependency; no Tauri
//! plugins. Worse, `windows_host.rs` set `stderr(Stdio::null())`, so a Node
//! stack trace printed on the way down went to the kernel's bit bucket, and
//! stdout was drained to nowhere once the handshake resolved.
//!
//! `failure.rs` gives a viewer seven named headlines for the failures the
//! shell ANTICIPATES. What was lost is the unanticipated one: the sidecar
//! starts, throws, prints the only explanation that exists, and exits — and
//! the shell can say no more than "the local service did not finish
//! starting". On a packaged build, on a machine no engineer can reach, that
//! was the whole of the evidence.
//!
//! ==========================================================================
//! WHY THE LOGIC IS HERE AND NOT IN `windows_host.rs`
//! ==========================================================================
//!
//! That file is `#[cfg(windows)]`. The redaction below is a SECURITY
//! property, and a security property that only compiles on a platform the
//! test suite cannot run is a security property nobody has tested. So this
//! module is portable and carries everything that can be wrong — what gets
//! redacted, how much is kept, what a line looks like — and the Windows file
//! keeps only the pipe and the file handle.
//!
//! ==========================================================================
//! WHAT MUST NEVER REACH THE FILE
//! ==========================================================================
//!
//! The launch token. `token.rs` mints it, PW-0101 exists to keep it from any
//! other process on the machine, and it travels to the child through the
//! ENVIRONMENT — never the command line, and never the handshake line, which
//! carries only `{host, port}`.
//!
//! So it should never appear in the child's output at all. "Should never"
//! is the reason to redact rather than the reason not to: a Node crash can
//! print its environment, a library can echo a header, and this file lands
//! in a world-readable profile directory. The shell KNOWS the token, so the
//! redaction is exact rather than a heuristic — no pattern that might match,
//! the actual secret, removed by value.
//!
//! The environment is never dumped here. This module writes only lines the
//! child printed, with the token taken out of them.

/// Characters kept from one run. Beyond this the log stops and says so.
///
/// A CAP RATHER THAN ROTATION, and the reason is the failure being captured.
/// This exists for a sidecar that dies during startup, which produces a
/// stack trace measured in kilobytes. A process that instead spins printing
/// a line a millisecond would fill a disk, and the matrix's own row E1 calls
/// unbounded growth over a long session a failure even without a crash.
/// Rotation would be more machinery than the thing it bounds; the first
/// megabyte of a failing start contains the failure.
pub const LOG_BUDGET_BYTES: usize = 1024 * 1024;

/// What replaces the launch token if it ever shows up in the child's output.
pub const REDACTION: &str = "[redacted: launch token]";

/// The line written when the budget runs out, so a truncated log says so.
pub const TRUNCATION_NOTICE: &str =
    "[log truncated: this run exceeded the capture budget; the lines above are the start of it]";

/// Accumulates the child's output, redacted and bounded.
///
/// It owns no file. The caller appends `take()`'s output wherever it likes,
/// which is what keeps this testable off Windows and keeps a failure to
/// write out of the launch path entirely.
#[derive(Debug)]
pub struct SidecarLog {
    token: String,
    written: usize,
    truncated: bool,
    pending: String,
}

impl SidecarLog {
    /// `token` is the launch token to redact. An empty token redacts nothing.
    ///
    /// EMPTY IS ALLOWED ON PURPOSE. A caller that could not mint a token is
    /// already failing the launch for a better reason, and making this
    /// constructor fallible would put a second failure mode on the path of
    /// the first. What it must not do is redact the empty string, which
    /// would match everywhere.
    pub fn new(token: &str) -> Self {
        Self {
            token: token.to_string(),
            written: 0,
            truncated: false,
            pending: String::new(),
        }
    }

    /// Record one line from the child, tagged with which stream it came from.
    ///
    /// `stream` is `"out"` or `"err"`. Both are kept: a Node process prints
    /// its handshake and its ordinary logging to stdout and its stack traces
    /// to stderr, and the interleaving of the two is often the diagnosis.
    pub fn line(&mut self, stream: &str, line: &str) {
        if self.truncated {
            return;
        }
        let safe = self.redact(line);
        let entry = format!("[{stream}] {safe}\n");

        if self.written + entry.len() > LOG_BUDGET_BYTES {
            self.truncated = true;
            self.pending.push_str(TRUNCATION_NOTICE);
            self.pending.push('\n');
            return;
        }
        self.written += entry.len();
        self.pending.push_str(&entry);
    }

    /// Record something the SHELL observed, rather than something the child
    /// printed. Redacted on the same path, because a shell message can quote
    /// a child's line.
    pub fn note(&mut self, message: &str) {
        self.line("shell", message);
    }

    /// Everything accumulated since the last call, leaving the buffer empty.
    pub fn take(&mut self) -> String {
        std::mem::take(&mut self.pending)
    }

    /// Has the budget been reached? Once true, nothing more is recorded.
    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    /// The token, removed by value.
    ///
    /// NOT A PATTERN. The shell minted this exact string, so it can take out
    /// precisely that and nothing else — no regex that might miss a form or
    /// catch a port number that happens to look like a secret.
    fn redact(&self, line: &str) -> String {
        if self.token.is_empty() {
            return line.to_string();
        }
        line.replace(&self.token, REDACTION)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real token shape: `token.rs` requires at least 64 hex characters.
    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn keeps_both_streams_and_tags_which_is_which() {
        let mut log = SidecarLog::new(TOKEN);
        log.line("out", "listening");
        log.line("err", "TypeError: undefined is not a function");
        let text = log.take();
        assert!(text.contains("[out] listening"));
        assert!(text.contains("[err] TypeError"));
    }

    #[test]
    fn the_launch_token_never_reaches_the_file() {
        // THE SECURITY PROPERTY. PW-0101 exists to keep this value from any
        // other process on the machine; a log file in a world-readable
        // profile directory would hand it over.
        let mut log = SidecarLog::new(TOKEN);
        log.line("err", &format!("Error: request rejected, token={TOKEN} was wrong"));
        let text = log.take();
        assert!(!text.contains(TOKEN), "the token was written to the log");
        assert!(text.contains(REDACTION));
        // and the rest of the line survives, or the redaction destroys the
        // diagnosis it was supposed to preserve
        assert!(text.contains("request rejected"));
    }

    #[test]
    fn redacts_every_occurrence_in_a_line_and_across_lines() {
        let mut log = SidecarLog::new(TOKEN);
        log.line("err", &format!("{TOKEN} and again {TOKEN}"));
        log.line("out", &format!("later: {TOKEN}"));
        let text = log.take();
        assert!(!text.contains(TOKEN));
        assert_eq!(text.matches(REDACTION).count(), 3);
    }

    #[test]
    fn an_empty_token_redacts_nothing_rather_than_everything() {
        // `"".replace("", X)` inserts X between every character. A caller
        // with no token is already failing the launch for a better reason,
        // and this must not turn its log into confetti.
        let mut log = SidecarLog::new("");
        log.line("out", "ordinary line");
        assert!(log.take().contains("[out] ordinary line"));
    }

    #[test]
    fn a_shell_note_goes_through_the_same_redaction() {
        let mut log = SidecarLog::new(TOKEN);
        log.note(&format!("spawning with {TOKEN}"));
        let text = log.take();
        assert!(!text.contains(TOKEN));
        assert!(text.contains("[shell]"));
    }

    #[test]
    fn stops_at_the_budget_and_says_that_it_did() {
        let mut log = SidecarLog::new(TOKEN);
        let chunk = "x".repeat(1000);
        for _ in 0..2000 {
            log.line("out", &chunk);
        }
        let text = log.take();
        assert!(log.is_truncated());
        assert!(text.contains(TRUNCATION_NOTICE));
        assert!(
            text.len() <= LOG_BUDGET_BYTES + TRUNCATION_NOTICE.len() + 64,
            "the budget did not hold: {} bytes",
            text.len()
        );
    }

    #[test]
    fn records_nothing_more_once_truncated() {
        let mut log = SidecarLog::new(TOKEN);
        log.line("out", &"y".repeat(LOG_BUDGET_BYTES + 1));
        let _ = log.take();
        log.line("out", "this must not appear");
        assert_eq!(log.take(), "");
    }

    /// Spawn a real child, capture it through `SidecarLog` the way
    /// `windows_host.rs` does, KILL it, and require its output to be on disk.
    ///
    /// ======================================================================
    /// THIS IS THE CLAUSE THAT MATTERS: "a real failure survives termination"
    /// ======================================================================
    ///
    /// The unit tests above prove the redaction and the budget. They prove
    /// nothing about the property the whole task exists for, which is that
    /// output written by a process that is KILLED -- not one that exits
    /// cleanly -- is still readable afterwards. The job object terminates the
    /// sidecar when the shell goes, so a killed child is the normal case, not
    /// the exotic one, and a design that flushed at exit would lose exactly
    /// the crash nobody can explain.
    ///
    /// So this spawns a real process, pipes its stderr, writes through the
    /// same accumulator with the same per-line flush, kills it, and reads the
    /// file back. It runs on Linux, which is the point: the arrangement under
    /// test is the ORDER of operations, and that is identical on both
    /// platforms. What it does not prove is Windows itself -- see the task's
    /// gate evidence, where that limit is stated rather than glossed.
    #[test]
    fn output_from_a_killed_child_is_on_disk_afterwards() {
        use std::io::{BufRead, BufReader, Read};
        use std::process::{Command, Stdio};

        let dir = std::env::temp_dir().join(format!("liberty-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("sidecar.log");
        let _ = std::fs::remove_file(&path);

        // Prints a diagnosis to stderr, then hangs. Killed below, so it never
        // reaches any exit path of its own.
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(format!("echo 'FATAL: cannot bind, token={TOKEN}' >&2; sleep 30"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn");

        let stderr = child.stderr.take().expect("stderr pipe");
        let mut sink = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .expect("log file");
        let mut log = SidecarLog::new(TOKEN);

        // One line is enough to make the point, and waiting for EOF would
        // mean waiting for the child we are about to kill.
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        reader.read_line(&mut line).expect("read a line");
        log.line("err", line.trim_end());
        {
            use std::io::Write as _;
            sink.write_all(log.take().as_bytes()).expect("write");
            sink.flush().expect("flush");
        }

        child.kill().expect("kill");
        let _ = child.wait();

        let mut written = String::new();
        std::fs::File::open(&path)
            .expect("reopen")
            .read_to_string(&mut written)
            .expect("read back");

        assert!(
            written.contains("FATAL: cannot bind"),
            "the killed child's diagnosis was lost: {written:?}"
        );
        assert!(!written.contains(TOKEN), "the token reached the file");
        assert!(written.contains(REDACTION));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn take_drains_so_the_caller_can_append_incrementally() {
        // The writer appends as the child runs rather than at exit, which is
        // the whole point: a process killed by the job object never reaches
        // an exit path, and anything buffered until then would be lost.
        let mut log = SidecarLog::new(TOKEN);
        log.line("out", "first");
        assert!(log.take().contains("first"));
        assert_eq!(log.take(), "");
        log.line("out", "second");
        let text = log.take();
        assert!(text.contains("second"));
        assert!(!text.contains("first"));
    }
}
