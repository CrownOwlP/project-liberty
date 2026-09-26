// A blank console window behind the application is the first thing a user sees
// and the last thing anybody remembers to fix. Windows-only attribute; ignored
// elsewhere.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

//! The entry point, and deliberately almost nothing else (PW-0102).
//!
//! Every decision this shell makes lives in `liberty_desktop`, the library
//! beside this binary, so that it can be unit-tested on a machine that cannot
//! produce or run a Windows executable. What is left here is the wiring that
//! only exists at runtime.

fn main() {
    liberty_desktop::run();
}
