//! How many times to restart, and when to stop (PW-0102).
//!
//! PURE, AND SEPARATED FROM THE SPAWNING FOR THAT REASON. Everything here is a
//! decision about a count and a clock; nothing here creates a process, opens a
//! handle or touches the filesystem. That is what lets the policy be tested
//! exhaustively on Linux, where the thing it supervises cannot even run.
//!
//! WHAT A BOUNDED BUDGET IS FOR. An unbounded restart loop against a sidecar
//! that cannot start -- a corrupt install, a port the machine will never let go,
//! a Node that will not execute -- is a process spawning forever behind a window
//! that shows nothing. The user's machine gets hot and the application looks
//! frozen. A budget turns that into a failure with a reason, which is the whole
//! difference between a bug report that can be acted on and "it doesn't work".
//!
//! WHY A SUCCESSFUL RUN RESETS IT. A sidecar that ran for an hour and then died
//! is a different event from one that has never started, and charging the first
//! against the same budget would mean a long-lived session eventually refuses to
//! recover from a single crash. `MIN_HEALTHY_RUN` is what separates them, and it
//! is deliberately short: the failure mode this budget exists for is a sidecar
//! that dies in under a second, repeatedly.

use std::time::Duration;

/// How many consecutive failed starts are tolerated before the shell gives up.
///
/// Four rather than "a few": three is enough to ride out a transient port
/// collision with a process that is exiting, and the fourth exists because the
/// first attempt is frequently the one that races an old instance's teardown.
/// Past that, the evidence is that it is not going to work.
pub const MAX_CONSECUTIVE_FAILURES: u32 = 4;

/// How long a run must last to count as healthy and clear the budget.
pub const MIN_HEALTHY_RUN: Duration = Duration::from_secs(20);

/// How long to wait for the handshake before treating the start as failed.
///
/// Generous, because a cold start on a spinning disk with an antivirus scanner
/// reading every file of a standalone Next tree is genuinely slow, and a shell
/// that gives up at five seconds would be unusable on exactly the machines that
/// need it most.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Start it again, after this delay.
    Restart { after: Duration },
    /// The budget is spent. Surface a failure; do not spawn again.
    GiveUp { attempts: u32 },
}

/// The supervisor's whole memory.
#[derive(Debug, Clone, Copy, Default)]
pub struct Budget {
    consecutive_failures: u32,
}

impl Budget {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures
    }

    /// Record that a sidecar run ended, and decide what to do about it.
    ///
    /// `ran_for` is how long the process lived. A run at or past
    /// `MIN_HEALTHY_RUN` clears the budget before it is charged, so a crash
    /// after a long healthy session is the FIRST failure rather than the next
    /// one in a sequence.
    pub fn record_exit(&mut self, ran_for: Duration) -> Decision {
        if ran_for >= MIN_HEALTHY_RUN {
            self.consecutive_failures = 0;
        }
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);

        if self.consecutive_failures > MAX_CONSECUTIVE_FAILURES {
            return Decision::GiveUp {
                attempts: self.consecutive_failures,
            };
        }
        Decision::Restart {
            after: backoff(self.consecutive_failures),
        }
    }
}

/// Exponential backoff, capped.
///
/// CAPPED RATHER THAN UNBOUNDED because the budget is small: with four attempts
/// an uncapped doubling reaches eight seconds, which is already most of what a
/// user will wait staring at a window. The cap is what keeps the total recovery
/// time bounded by something a person will tolerate.
///
/// No jitter. Jitter exists to stop a fleet of clients synchronising on a shared
/// server; there is one shell and one sidecar on one machine, and there is
/// nothing to desynchronise from.
fn backoff(attempt: u32) -> Duration {
    const CAP: Duration = Duration::from_secs(4);
    let millis = 250u64.saturating_mul(1u64 << attempt.min(6));
    let delay = Duration::from_millis(millis);
    if delay > CAP {
        CAP
    } else {
        delay
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sidecar_that_never_starts_gives_up_after_the_budget() {
        // The failure this exists for: a corrupt install, or a port the machine
        // will not release. Four restarts, then a stated failure -- never an
        // unbounded loop behind a blank window.
        let mut budget = Budget::new();
        let instant = Duration::from_millis(200);
        for attempt in 1..=MAX_CONSECUTIVE_FAILURES {
            match budget.record_exit(instant) {
                Decision::Restart { .. } => {}
                other => panic!("attempt {attempt} should restart, got {other:?}"),
            }
        }
        assert_eq!(
            budget.record_exit(instant),
            Decision::GiveUp {
                attempts: MAX_CONSECUTIVE_FAILURES + 1
            }
        );
    }

    #[test]
    fn a_healthy_run_clears_the_budget() {
        // A crash after an hour is a first failure, not the fifth. Without this,
        // a long session eventually refuses to recover from one crash.
        let mut budget = Budget::new();
        for _ in 0..MAX_CONSECUTIVE_FAILURES {
            budget.record_exit(Duration::from_millis(100));
        }
        assert_eq!(budget.consecutive_failures(), MAX_CONSECUTIVE_FAILURES);

        match budget.record_exit(MIN_HEALTHY_RUN) {
            Decision::Restart { .. } => {}
            other => panic!("a healthy run must not be the one that gives up: {other:?}"),
        }
        assert_eq!(
            budget.consecutive_failures(),
            1,
            "a healthy run clears the budget before its own failure is charged"
        );
    }

    #[test]
    fn a_run_just_short_of_healthy_still_counts_against_the_budget() {
        // The boundary, asserted, because "roughly twenty seconds" is not a rule.
        let mut budget = Budget::new();
        budget.record_exit(MIN_HEALTHY_RUN - Duration::from_millis(1));
        budget.record_exit(MIN_HEALTHY_RUN - Duration::from_millis(1));
        assert_eq!(budget.consecutive_failures(), 2);
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        // Growth so a transient collision is not hammered; a cap because the
        // total wait is what a person experiences.
        assert!(backoff(1) < backoff(2));
        assert!(backoff(2) < backoff(3));
        for attempt in 0..64u32 {
            assert!(
                backoff(attempt) <= Duration::from_secs(4),
                "attempt {attempt} exceeded the cap"
            );
        }
    }

    #[test]
    fn the_backoff_shift_cannot_overflow() {
        // `1 << attempt` with an unclamped u32 is undefined past 63 and panics in
        // debug. The clamp is asserted rather than assumed, because the input is
        // a counter and counters grow.
        assert_eq!(backoff(u32::MAX), Duration::from_secs(4));
    }

    #[test]
    fn the_total_recovery_time_is_something_a_person_will_wait() {
        // The budget and the cap have to be read together: four restarts at a
        // four-second cap is the worst case a user sits through before being
        // told what went wrong.
        let mut budget = Budget::new();
        let mut total = Duration::ZERO;
        loop {
            match budget.record_exit(Duration::from_millis(50)) {
                Decision::Restart { after } => total += after,
                Decision::GiveUp { .. } => break,
            }
        }
        assert!(
            total <= Duration::from_secs(15),
            "worst-case wait before a stated failure was {total:?}"
        );
    }
}
