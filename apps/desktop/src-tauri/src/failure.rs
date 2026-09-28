//! What the user sees when the sidecar will not start (PW-0102).
//!
//! NEVER A BLANK WINDOW. A shell whose sidecar failed has three options: show
//! nothing, show a spinner forever, or say what happened. The first two are the
//! same thing to a user -- an application that is broken in a way they cannot
//! describe to anybody -- and they are what produces "it just doesn't open".
//!
//! THE TEXT IS BUILT HERE, AS DATA, so it can be asserted. A failure message
//! assembled inline at the point of failure is one nobody tests, and this one
//! carries the single most important property of the whole module: it must not
//! leak the launch token.

use crate::job::JobError;
use crate::sidecar::LaunchError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupFailure {
    /// The packaged runtime or server is missing, or the token was unusable.
    Launch(LaunchError),
    /// Supervision could not be established. NOT a reason to run anyway: an
    /// unsupervised sidecar is the orphaned `node.exe` this design exists to
    /// prevent.
    Supervision(JobError),
    /// The sidecar started and never reported a port.
    NoHandshake { waited_seconds: u64 },
    /// The sidecar said something, and it was not a usable handshake.
    BadHandshake(String),
    /// It kept dying, and the restart budget is spent.
    Unstable { attempts: u32 },
}

/// What the user is told, and what they can do about it.
///
/// TWO FIELDS, because they are for different readers. `headline` is for the
/// person looking at the window; `detail` is what they paste into a support
/// request. Collapsing them produces a message that is either too technical to
/// read or too vague to act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailureReport {
    pub headline: String,
    pub detail: String,
    /// Whether trying again could plausibly work. A port collision might clear;
    /// a missing file will not.
    pub retry_may_help: bool,
}

pub fn describe(failure: &StartupFailure) -> FailureReport {
    match failure {
        StartupFailure::Launch(LaunchError::Missing { what, at }) => FailureReport {
            headline: "Project Liberty is missing part of its installation".into(),
            detail: format!(
                "The packaged {what} was not found at {}. Reinstalling should replace it.",
                at.display()
            ),
            retry_may_help: false,
        },
        StartupFailure::Launch(LaunchError::Unwritable { detail }) => FailureReport {
            headline: "Project Liberty could not write to your profile".into(),
            /*
             * A DIFFERENT REMEDY FROM THE MISSING-RESOURCE ARM ABOVE, which is
             * why it is a different variant. That one says reinstall; this one
             * cannot, because reinstalling replaces files under Program Files
             * and the thing that failed is under the user's own profile. The
             * causes a person can act on are disk space, a policy that
             * redirects the local app-data folder, and a security product
             * holding the directory -- so the text names the path and stops.
             *
             * THE INNER DETAIL IS FORWARDED, unlike the token arm below. It is
             * an operating-system message about a directory, carrying no
             * credential, and it is the only thing that distinguishes "the
             * disk is full" from "access is denied".
             */
            detail: format!(
                "{detail} This is usually disk space, a policy that redirects your local \
                 application data folder, or a security product holding it open. Reinstalling \
                 will not help: the folder is in your user profile, not in the installation."
            ),
            retry_may_help: true,
        },
        StartupFailure::Launch(LaunchError::Token(_)) => FailureReport {
            headline: "Project Liberty could not secure its local connection".into(),
            /*
             * THE DETAIL DELIBERATELY DROPS THE INNER MESSAGE. Every other arm
             * forwards it; this one does not, because the inner error is about
             * the token and a failure report is pasted into support tickets by
             * people who should not be asked to redact a credential. The length
             * and the character class are not worth the risk of a future edit
             * putting the value itself in the same string.
             */
            detail: "The one-time key this launch uses to talk to its own local service could not be prepared. Restarting the application generates a new one.".into(),
            retry_may_help: true,
        },
        StartupFailure::Supervision(error) => FailureReport {
            headline: "Project Liberty could not start safely".into(),
            detail: format!(
                "{error}. Rather than leave a background process running that nothing can stop, the application stopped instead."
            ),
            retry_may_help: true,
        },
        StartupFailure::NoHandshake { waited_seconds } => FailureReport {
            headline: "Project Liberty's local service did not finish starting".into(),
            detail: format!(
                "The service was given {waited_seconds} seconds to report a port and did not. On a slow disk, or with an antivirus scanner reading the installation for the first time, a second attempt often succeeds."
            ),
            retry_may_help: true,
        },
        StartupFailure::BadHandshake(reason) => FailureReport {
            headline: "Project Liberty's local service reported something unusable".into(),
            detail: format!("{reason}. This is a defect rather than a configuration problem; the detail above is worth reporting."),
            retry_may_help: false,
        },
        StartupFailure::Unstable { attempts } => FailureReport {
            headline: "Project Liberty's local service keeps stopping".into(),
            detail: format!(
                "It was started {attempts} times and stopped each time. Something on this machine is preventing it from running -- most often another copy still shutting down, or security software blocking it."
            ),
            retry_may_help: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn all_failures() -> Vec<StartupFailure> {
        vec![
            StartupFailure::Launch(LaunchError::Missing {
                what: "Node runtime",
                at: PathBuf::from("C:\\Program Files\\Liberty\\sidecar\\node.exe"),
            }),
            StartupFailure::Launch(LaunchError::Token(format!("token {TOKEN} is too short"))),
            StartupFailure::Supervision(JobError::Create("GetLastError=5".into())),
            StartupFailure::NoHandshake { waited_seconds: 45 },
            StartupFailure::BadHandshake("handshake host \"0.0.0.0\" is not a loopback address".into()),
            StartupFailure::Unstable { attempts: 5 },
        ]
    }

    #[test]
    fn no_failure_report_can_contain_the_launch_token() {
        // THE ASSERTION THIS MODULE EXISTS FOR. A failure report is shown on
        // screen and pasted into support requests. The token is the credential
        // that separates this application's listener from every other process on
        // the machine, and the Token arm is constructed here with the token
        // embedded in its inner message precisely so that forwarding it would
        // fail this test.
        for failure in all_failures() {
            let report = describe(&failure);
            assert!(
                !report.headline.contains(TOKEN) && !report.detail.contains(TOKEN),
                "token leaked in {failure:?}"
            );
        }
    }

    #[test]
    fn every_failure_says_something_and_none_is_blank() {
        // A blank window is what this module exists to prevent; a blank message
        // is the same failure one layer up.
        for failure in all_failures() {
            let report = describe(&failure);
            assert!(!report.headline.trim().is_empty(), "{failure:?}");
            assert!(report.detail.trim().len() > 30, "{failure:?}");
        }
    }

    #[test]
    fn retry_advice_matches_whether_retrying_could_work() {
        // Telling somebody to try again when a file is missing wastes their time
        // and teaches them to ignore the advice.
        assert!(!describe(&StartupFailure::Launch(LaunchError::Missing {
            what: "Node runtime",
            at: PathBuf::from("x"),
        }))
        .retry_may_help);
        assert!(describe(&StartupFailure::NoHandshake { waited_seconds: 45 }).retry_may_help);
        assert!(!describe(&StartupFailure::Unstable { attempts: 5 }).retry_may_help);
    }

    #[test]
    fn supervision_failure_explains_why_the_app_stopped_rather_than_continuing() {
        // The non-obvious decision: refusing to run unsupervised is deliberate,
        // and a user who is not told that will think the app crashed.
        let report = describe(&StartupFailure::Supervision(JobError::Create("x".into())));
        assert!(report.detail.contains("background process"));
    }
}
