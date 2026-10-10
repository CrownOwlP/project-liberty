//! mpv, configured to render into a DirectComposition swapchain instead of a
//! window.
//!
//! THE THREE FACTS THIS MODULE RESTS ON, each read out of mpv's own source at
//! the EXACT commit this project pins (`c152964208`), not at master:
//!
//! 1. `--d3d11-output-mode=composition` makes the d3d11 context create its
//!    swapchain with `.window = NULL`
//!    (`video/out/d3d11/context.c`: `.window = ctx->opts.composition ? NULL :
//!    vo_w32_hwnd(ctx->vo)`). No window is created, so nothing can occlude
//!    anything.
//! 2. `--d3d11-composition-size=<WxH>` supplies the size a window would have
//!    (`options/options.c`: `{"d3d11-composition-size", OPT_SIZE_BOX(...)}`,
//!    read by `vo_w32_composition_size`). With no window there is nothing
//!    else to measure, and mpv errors out if it is unset or zero.
//! 3. The `display-swapchain` property returns the `IDXGISwapChain*` as an
//!    `int64` (`player/command.c`:
//!    `{"display-swapchain", mp_property_vo_display_swapchain}`), and is
//!    `M_PROPERTY_UNAVAILABLE` until BOTH the VO exists and its swapchain is
//!    set. **That is why it has to be polled rather than read once** -- the VO
//!    comes up lazily, after `loadfile`, when the first frame needs it.

use crate::diag::Diag;

/// Properties worth watching, and the reason each one is here rather than a
/// general sweep. Criteria 4 and 7 are the two this experiment can observe
/// from inside; the rest separate "nothing loaded" from "loaded, not shown",
/// which is the distinction Experiment 1a's first run could not make.
pub const WATCHED: [&str; 14] = [
    /* --- criterion 7: live telemetry -------------------------------------- */
    "time-pos",
    "avsync",
    "pause",
    /* --- criterion 4: hardware decode ------------------------------------- */
    "hwdec-current",
    "video-codec",
    /* --- is anything loaded at all? --------------------------------------- */
    "idle-active",
    "core-idle",
    "filename",
    "duration",
    /* --- did a video stream decode, and at what size? --------------------- */
    "video-params/w",
    "video-params/h",
    "video-params/pixelformat",
    /* --- did the video OUTPUT come up, and is it the composition one? -----
     * `current-vo` should read gpu-next. `vo-configured` separates "mpv never
     * loaded a file" from "mpv loaded it and could not put it anywhere". */
    "vo-configured",
    "current-vo",
];

/// Decode `Raw(-10)` into mpv's own words. `-10` is
/// `MPV_ERROR_PROPERTY_UNAVAILABLE`, which is the ORDINARY answer for
/// `time-pos` and `avsync` while nothing is playing -- Experiment 1a's first
/// run wasted a round on it looking like a defect.
pub fn explain(error: &libmpv2::Error) -> String {
    match error {
        libmpv2::Error::Raw(code) => {
            let text = unsafe { libmpv2_sys::mpv_error_string(*code) };
            if text.is_null() {
                return format!("mpv error {code}");
            }
            let text = unsafe { std::ffi::CStr::from_ptr(text) }.to_string_lossy();
            format!("{text} (mpv error {code})")
        }
        other => format!("{other:?}"),
    }
}

/// `mpv_request_log_messages` is documented "unimplemented" in libmpv2, but
/// `Mpv::ctx` is public, so the sys call is reachable. With `terminal=no` this
/// is the only route to mpv's own account of what it did.
pub fn request_log(mpv: &libmpv2::Mpv, level: &str) -> Result<(), String> {
    let level = std::ffi::CString::new(level).map_err(|e| e.to_string())?;
    let rc = unsafe { libmpv2_sys::mpv_request_log_messages(mpv.ctx.as_ptr(), level.as_ptr()) };
    if rc < 0 {
        return Err(format!("mpv_request_log_messages returned {rc}"));
    }
    Ok(())
}

/// Create and initialise mpv in composition mode, then queue the file.
///
/// Deliberately the SAME property set as Experiment 1a, with exactly two
/// changes -- `d3d11-output-mode` and `d3d11-composition-size` replace `wid`.
/// Experiment 1a proved this decode path works on the commander's hardware
/// (HEVC open, D3D11 on an RTX 3050, `d3d11va` active, `gpu-next` configured,
/// first frame reported shown). Changing anything else here would put that
/// proven result back in doubt for no reason.
pub fn start(file: &str, width: i32, height: i32, diag: &Diag) -> Result<libmpv2::Mpv, String> {
    /*
     * THE FILE, BEFORE mpv IS BLAMED FOR IT. Carried over from Experiment 1a
     * for the same reason: "we passed the wrong string" and "mpv refused the
     * right one" produce identical symptoms, so they get separate lines
     * before loadfile is called.
     */
    diag.say(&format!("file argument, {} bytes: {file:?}", file.len()));
    match std::fs::metadata(file) {
        Ok(meta) => diag.ok(&format!(
            "the path EXISTS on disk: {} bytes, is_file={}",
            meta.len(),
            meta.is_file()
        )),
        Err(error) => diag.fail(&format!(
            "the path DOES NOT RESOLVE from this process: {error}. If the file is really there \
             this is a quoting or working-directory problem and not an mpv problem."
        )),
    }

    let size = format!("{width}x{height}");
    diag.step(&format!(
        "mpv_create + set options + mpv_initialize (composition size {size})"
    ));

    /*
     * `with_initializer` SETS THESE BEFORE mpv_initialize, WHICH IS REQUIRED
     * RATHER THAN TIDY. `vo` and `gpu-context` cannot be changed after
     * initialisation, and `d3d11_init` reads `d3d11-output-mode` ONCE to
     * decide whether to create a window at all -- so a composition size
     * arriving later would arrive after `vo_w32_composition_size` had already
     * failed with "Failed to get height and width!".
     *
     * EVERY OTHER PROPERTY IS EXACTLY EXPERIMENT 1a's. That experiment proved
     * this decode path on the commander's hardware -- HEVC open, D3D11 on an
     * RTX 3050, `d3d11va` active, `gpu-next` configured, first frame reported
     * shown. The two additions replace `wid`; changing anything else would put
     * a proven result back in doubt for no reason.
     */
    let mpv = libmpv2::Mpv::with_initializer(|init| {
        init.set_property("vo", "gpu-next,gpu")?;
        init.set_property("gpu-context", "d3d11")?;
        init.set_property("d3d11-output-mode", "composition")?;
        init.set_property("d3d11-composition-size", size.as_str())?;
        init.set_property("hwdec", "auto")?;
        init.set_property("terminal", "no")?;
        init.set_property("osc", "no")?;
        init.set_property("input-default-bindings", "no")?;
        init.set_property("config", "no")?;
        Ok(())
    })
    .map_err(|e| {
        format!(
            "mpv_create/initialize FAILED in composition mode: {}. If this is the composition \
             options being rejected, the libmpv build next to this exe predates \
             --d3d11-output-mode (added in mpv 0.41.0) and the experiment cannot be judged on \
             this run.",
            explain(&e)
        )
    })?;
    diag.ok("mpv_create + mpv_initialize in composition mode: no window was created");

    /* BEFORE loadfile, so the log carries the demuxer and the VO deciding what
     * to do rather than starting after they already have. */
    match request_log(&mpv, "v") {
        Ok(()) => diag.ok("mpv verbose log capture requested"),
        Err(error) => diag.fail(&format!(
            "mpv log capture unavailable: {error}. The run will be harder to read."
        )),
    }

    diag.step(&format!("loadfile {file:?}"));
    mpv.command("loadfile", &[file]).map_err(|e| {
        let why = explain(&e);
        diag.fail(&format!("loadfile REFUSED OUTRIGHT: {why}"));
        format!("loadfile {file} failed: {why}")
    })?;
    diag.ok("loadfile ACCEPTED (queued; this is not yet playback)");

    Ok(mpv)
}

/// The composition swapchain, as a raw pointer, or `None` while the VO is
/// still coming up.
///
/// Returning `None` is the NORMAL state for the first few hundred
/// milliseconds after `loadfile` and must not be reported as a failure -- mpv
/// creates the VO lazily when the first frame needs it. What WOULD be a
/// failure is this never becoming `Some`, and the caller counts the polls so
/// it can say so.
pub fn display_swapchain(mpv: &libmpv2::Mpv) -> Result<Option<*mut std::ffi::c_void>, String> {
    match mpv.get_property::<i64>("display-swapchain") {
        Ok(0) => Ok(None),
        Ok(value) => Ok(Some(value as usize as *mut std::ffi::c_void)),
        // -10 is MPV_ERROR_PROPERTY_UNAVAILABLE: the VO is not up yet.
        Err(libmpv2::Error::Raw(-10)) => Ok(None),
        Err(error) => Err(explain(&error)),
    }
}

/// Keep mpv's idea of its own size matched to the window. With no window there
/// is nothing for mpv to measure, so this option IS the resize path --
/// `options/options.c` marks it as one of the two that trigger a VO resize
/// when it changes.
pub fn resize(mpv: &libmpv2::Mpv, width: i32, height: i32) -> Result<(), String> {
    if width <= 0 || height <= 0 {
        return Err(format!(
            "refusing to set a composition size of {width}x{height}"
        ));
    }
    mpv.set_property(
        "d3d11-composition-size",
        format!("{width}x{height}").as_str(),
    )
    .map_err(|e| explain(&e))
}
