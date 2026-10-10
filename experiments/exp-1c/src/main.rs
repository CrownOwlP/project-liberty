//! Experiment 1c — the compositing proof, second attempt.
//!
//! `docs/DESKTOP_PLAYBACK.md` §1 and §10. **This is a THROWAWAY.** It is not
//! product code, it is not a workspace member, nothing in Project Liberty
//! imports it, and it is not shipped.
//!
//! WHY IT EXISTS. Experiment 1a asked whether a child HWND running libmpv can
//! composite BENEATH a transparent WebView2. It was run three times on the
//! commander's hardware and the answer was no: mpv decoded on the GPU,
//! configured `gpu-next` at the child window's real size, reported the first
//! frame shown, the Pause button reached mpv, and
//! `put_DefaultBackgroundColor(0,0,0,0)` was accepted — and the commander saw
//! no video at all. Criterion 1 PASS, criterion 3 PASS, criterion 2 FAIL.
//!
//! So this asks a different question about the same product requirement:
//!
//!   **Can mpv's D3D11 composition swapchain and WebView2's composition visual
//!   live in ONE DirectComposition visual tree, with the HTML visibly tinting
//!   the video and still able to receive clicks?**
//!
//! THE DIFFERENCE, IN ONE SENTENCE. In 1a the two layers were two WINDOWS and
//! window z-order decided what the user saw. Here neither layer owns a window:
//! both are content in one visual tree that DWM composites.
//!
//! WHAT IS DELIBERATELY ABSENT, because the spec says so and because every one
//! of them would make a failure ambiguous: no Tauri, no Next.js, no sidecar, no
//! adapter, no product code, no provider, no network, no DRM routing, no
//! packaging, no LGPL build, no touch or pen input.
//!
//! WHAT A RUN CANNOT BE CLAIMED TO PROVE. Compiling proves nothing about the
//! experiment. Every one of the eight criteria in `README.md` is something a
//! person has to look at, and the OS/GPU/DPI matrix in §10 is unchanged and
//! unmet by any single machine.

#![cfg_attr(not(windows), allow(unused))]

#[cfg(windows)]
mod dcomp;
#[cfg(windows)]
mod diag;
#[cfg(windows)]
mod player;
#[cfg(windows)]
mod web;

#[cfg(windows)]
mod host;

fn main() {
    let file = std::env::args().nth(1).unwrap_or_default();
    if file.is_empty() {
        eprintln!(
            "exp-1c: pass the path to a LOCAL video file.\n\
             \n\
                 exp-1c.exe \"C:\\\\path\\\\to\\\\clip.mkv\"\n\
             \n\
             docs/DESKTOP_PLAYBACK.md section 10 asks for 4K60 HEVC or AV1. A smaller or\n\
             software-friendly clip will still show compositing, but it CANNOT test the\n\
             hardware-decode criterion, so a pass recorded from one would not be a pass."
        );
        std::process::exit(2);
    }

    #[cfg(windows)]
    {
        if let Err(error) = host::run(&file) {
            eprintln!("exp-1c: {error}");
            std::process::exit(1);
        }
    }

    #[cfg(not(windows))]
    {
        let _ = file;
        eprintln!(
            "exp-1c is a Windows experiment: it is about DirectComposition, WebView2 and \
             mpv's D3D11 output. There is nothing for it to do on this platform."
        );
        std::process::exit(2);
    }
}
