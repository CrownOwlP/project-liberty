//! The Windows Job Object that owns the sidecar's lifetime (PW-0102).
//!
//! THE FAILURE THIS PREVENTS IS THE ONE USERS ACTUALLY REPORT: "it will not
//! start the second time." Tauri provides no process supervision. If the shell
//! exits -- cleanly, by crash, or because Task Manager ended it -- a child
//! `node.exe` spawned with `Command::spawn` keeps running, keeps its loopback
//! port bound, and the next launch cannot bind. The user sees a window that
//! never loads and a machine that appears to be fine.
//!
//! A JOB OBJECT WITH `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` IS THE ONLY MECHANISM
//! THAT SURVIVES THE CASE THAT MATTERS. The alternatives were considered and
//! each fails in the same place:
//!
//!   - a `Drop` impl that kills the child: never runs when the parent is killed;
//!   - an atexit / ctrl-handler: same, and Windows gives no guaranteed window;
//!   - the child polling for its parent: a child that is itself wedged cannot;
//!   - `taskkill /T` on the tree: needs the shell to still be alive to run it.
//!
//! The kernel enforces the Job Object. When the last handle to the job closes
//! -- which happens when the process holding it terminates, however it
//! terminates -- every process still in the job is terminated. That is a
//! guarantee the user-mode alternatives cannot make.
//!
//! THIS MODULE IS WINDOWS-ONLY AND COMPILES TO NOTHING ELSEWHERE. The
//! `#[cfg(windows)]` is on the implementation, not on the call site, so the
//! caller has one code path and the platform difference lives here.
//!
//! NOT VERIFIED ON WINDOWS. `cargo check --target x86_64-pc-windows-msvc`
//! proves this compiles for Windows; it does not prove the kernel behaves as
//! described, because nothing in this environment can run a Windows binary.
//! That observation is owed to PW-0601 on a real machine or to a
//! `windows-latest` CI job.

/// A handle to a job that kills its members when dropped.
///
/// On non-Windows this is an empty struct with the same API, so the supervisor
/// has no `cfg` in it. The shell is a Windows product; the Linux build exists
/// only so that this crate can be checked and unit-tested where the work is done.
#[derive(Debug)]
pub struct KillOnCloseJob {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobError {
    /// The job could not be created. A deployment where this fails is a
    /// deployment where the orphan risk is real, so the caller refuses rather
    /// than continuing unsupervised.
    Create(String),
    /// The limit could not be set. Same reasoning: a job with no
    /// KILL_ON_JOB_CLOSE is a job that does not do the one thing it is for.
    Configure(String),
    /// The child could not be assigned. The child is already running at this
    /// point, so the caller must kill it itself rather than leave it outside the
    /// job -- which is precisely the orphan this module exists to prevent.
    Assign(String),
    /// This platform has no job objects. Never returned on Windows.
    Unsupported,
}

impl std::fmt::Display for JobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JobError::Create(detail) => write!(f, "could not create the job object: {detail}"),
            JobError::Configure(detail) => {
                write!(f, "could not set kill-on-close on the job object: {detail}")
            }
            JobError::Assign(detail) => {
                write!(f, "could not assign the sidecar to the job object: {detail}")
            }
            JobError::Unsupported => write!(
                f,
                "job objects are a Windows facility and this build is not for Windows"
            ),
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::{JobError, KillOnCloseJob};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JobObjectExtendedLimitInformation,
    };

    fn last_error() -> String {
        // The numeric code, not a formatted message. `FormatMessageW` is
        // localised, so a support ticket would arrive in a language the log
        // reader may not have, and the code is what is searchable.
        format!("GetLastError={}", unsafe { GetLastError() })
    }

    pub fn create() -> Result<KillOnCloseJob, JobError> {
        // SAFETY: both arguments are null, which the API documents as "no
        // security attributes, unnamed". An unnamed job is deliberate: a named
        // one could be opened by another process on the machine, and this job's
        // whole purpose is to hold a lifetime this process owns.
        let handle: HANDLE = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(JobError::Create(last_error()));
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        // SAFETY: `info` is a correctly zeroed structure of the type the
        // information class names, and the size is taken from the type rather
        // than written as a literal.
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            let detail = last_error();
            // The handle is closed on the failure path. A job with no limit set
            // is worse than no job: it would be held, look supervised, and kill
            // nothing.
            unsafe { CloseHandle(handle) };
            return Err(JobError::Configure(detail));
        }

        Ok(KillOnCloseJob { handle })
    }

    pub fn assign(job: &KillOnCloseJob, process: HANDLE) -> Result<(), JobError> {
        // SAFETY: both handles are owned by this process and still open --
        // `job.handle` for the life of the struct, and `process` for the life of
        // the `Child` the caller holds.
        let ok = unsafe { AssignProcessToJobObject(job.handle, process) };
        if ok == 0 {
            return Err(JobError::Assign(last_error()));
        }
        Ok(())
    }

    pub fn close(job: &mut KillOnCloseJob) {
        // Closing the last handle is what fires KILL_ON_JOB_CLOSE. There is
        // nothing to check: if it fails the process is exiting anyway, and a
        // process exit closes its handles regardless.
        unsafe { CloseHandle(job.handle) };
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{JobError, KillOnCloseJob};

    pub fn create() -> Result<KillOnCloseJob, JobError> {
        Err(JobError::Unsupported)
    }

    pub fn assign(_job: &KillOnCloseJob, _process: RawHandle) -> Result<(), JobError> {
        Err(JobError::Unsupported)
    }

    pub fn close(_job: &mut KillOnCloseJob) {}

    /// Stands in for the Windows `HANDLE` so the signatures match on both
    /// platforms and the supervisor needs no `cfg`.
    pub type RawHandle = usize;
}

#[cfg(windows)]
pub type RawProcessHandle = windows_sys::Win32::Foundation::HANDLE;
#[cfg(not(windows))]
pub type RawProcessHandle = imp::RawHandle;

impl KillOnCloseJob {
    /// Create a job whose members die when this handle closes.
    pub fn create() -> Result<Self, JobError> {
        imp::create()
    }

    /// Put a running process into the job.
    ///
    /// CALLED IMMEDIATELY AFTER SPAWN AND BEFORE ANYTHING ELSE. There is an
    /// unavoidable window between `CreateProcess` returning and this call: if
    /// the shell is killed inside it, the child is an orphan. The window cannot
    /// be closed from user mode without `CREATE_SUSPENDED` and a manual resume,
    /// which trades a microsecond-scale race for a class of hangs that are much
    /// harder to diagnose. It is narrowed instead, and stated here so that
    /// nobody later concludes it was not noticed.
    pub fn assign(&self, process: RawProcessHandle) -> Result<(), JobError> {
        imp::assign(self, process)
    }
}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        imp::close(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_error_messages_name_the_step_that_failed() {
        // Four failures with four different remedies. A single "job error"
        // would tell an operator nothing about whether the child is running.
        assert!(JobError::Create("GetLastError=5".into())
            .to_string()
            .contains("create"));
        assert!(JobError::Configure("GetLastError=87".into())
            .to_string()
            .contains("kill-on-close"));
        assert!(JobError::Assign("GetLastError=5".into())
            .to_string()
            .contains("assign"));
        assert!(JobError::Unsupported.to_string().contains("Windows"));
    }

    #[cfg(not(windows))]
    #[test]
    fn a_non_windows_build_refuses_rather_than_pretending_to_supervise() {
        // The supervisor must not silently run unsupervised off Windows. This is
        // the assertion that keeps the stub honest.
        assert_eq!(KillOnCloseJob::create().unwrap_err(), JobError::Unsupported);
    }
}
