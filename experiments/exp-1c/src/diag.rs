//! The diagnostic log, carried over from Experiment 1a's PL-0748 because it is
//! the single highest-value thing three rounds on that experiment taught.
//!
//! Experiment 1a's first run showed a window, showed an overlay, played
//! nothing, and could not say why -- which cost a whole round. Every
//! construction step in this experiment therefore reports its own outcome by
//! name, so that a run which shows nothing says WHERE it stopped instead of
//! requiring another round to find out.

use std::sync::Mutex;

pub struct Diag {
    file: Mutex<Option<std::fs::File>>,
    pub path: Option<String>,
}

impl Diag {
    /// Beside the exe, not in the working directory: the commander launches
    /// this from its own folder and a log written somewhere else is a log
    /// nobody sends back.
    pub fn open() -> Self {
        let path = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("exp-1c-diagnostic.log")));
        let file = path.as_ref().and_then(|p| std::fs::File::create(p).ok());
        Self {
            file: Mutex::new(file),
            path: path.map(|p| p.display().to_string()),
        }
    }

    /// Flushed per line. A crash must not take the explanation with it, and in
    /// this experiment a crash is one of the outcomes worth distinguishing.
    pub fn say(&self, line: &str) {
        use std::io::Write;
        if let Ok(mut guard) = self.file.lock() {
            if let Some(file) = guard.as_mut() {
                let _ = writeln!(file, "{line}");
                let _ = file.flush();
            }
        }
    }

    /// `step` and `ok`/`fail` exist so the log reads as a checklist. A reader
    /// looking for the first FAIL does not have to understand the prose.
    pub fn step(&self, what: &str) {
        self.say(&format!("STEP  {what}"));
    }

    pub fn ok(&self, what: &str) {
        self.say(&format!("  OK  {what}"));
    }

    pub fn fail(&self, what: &str) {
        self.say(&format!("FAIL  {what}"));
    }
}
