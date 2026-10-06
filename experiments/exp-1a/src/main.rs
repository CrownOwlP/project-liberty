//! Experiment 1a — the compositing proof. Nothing else.
//!
//! `docs/DESKTOP_PLAYBACK.md` §10. This is a THROWAWAY. It is not product
//! code, it is not wired into the application build, and the only question it
//! exists to answer is:
//!
//!   **Can a child HWND running libmpv composite BENEATH a transparent
//!   WebView2, with the HTML still visible over the video and still able to
//!   receive clicks?**
//!
//! The whole choice of Tauri (decision D1) rests on that answer and it has
//! never been run. If it fails, the pivot is wry/tao or `webview2` plus
//! `native-windows-gui` directly — and the right response to a failure is to
//! take D1 back through architecture review, not to work around it here.
//!
//! WHAT IS DELIBERATELY ABSENT, because the spec says so and because every
//! one of them would make a failure ambiguous: no Next.js, no sidecar, no
//! adapter, no product code, no provider, no network, no DRM routing, no
//! packaging, no LGPL build.
//!
//! WHAT A RUN CANNOT BE CLAIMED TO PROVE. Compiling this proves nothing about
//! the experiment. The pass criteria are in `README.md` and every one of them
//! is something a person has to look at.

#![cfg_attr(not(windows), allow(unused))]

use serde::Serialize;

/// Properties §10 step 5 asks to observe and forward to the overlay, plus
/// `hwdec-current`, which step 5 does not list but which the FIRST pass
/// criterion names as one of its two required readings. Watching it here is
/// the difference between the overlay showing the answer and the commander
/// having to find it somewhere else mid-run.
const WATCHED: [&str; 19] = [
    /* --- §10 step 5, unchanged ------------------------------------------ */
    "time-pos",
    "pause",
    "paused-for-cache",
    "cache-buffering-state",
    "avsync",
    "track-list",
    "hwdec-current",
    /* --- PL-0748: is anything loaded at all? ----------------------------
     * The first run showed track-list [] and time-pos unavailable, which is
     * the signature of an IDLE core rather than a broken one. These say so
     * directly instead of leaving it to be inferred. */
    "idle-active",
    "core-idle",
    "path",
    "filename",
    "file-format",
    "duration",
    /* --- did a video stream decode? ------------------------------------- */
    "video-params/w",
    "video-params/h",
    "video-params/pixelformat",
    "video-codec",
    /* --- did the video OUTPUT come up on the child HWND? ----------------
     * `vo-configured` separates "mpv never loaded a file" from "mpv loaded it
     * and could not put it on screen", which are hypotheses 1 and 4 and have
     * entirely different consequences for decision D1. */
    "vo-configured",
    "current-vo",
];

/// One poll of mpv, as the overlay renders it.
#[derive(Default, Serialize, Clone)]
struct Status {
    /// `name -> value`, stringified. The overlay is a debug surface; typing
    /// each property would be product polish this experiment must not grow.
    properties: std::collections::BTreeMap<String, String>,
    /// Set when mpv could not be reached at all, so the overlay shows a
    /// reason rather than going quietly blank.
    error: Option<String>,
    /// PL-0748. The last few mpv events, newest last, and the last thing that
    /// looked like a failure. The first real run produced a window, an
    /// overlay, and no way at all to find out why nothing played; these three
    /// fields are what that run needed and did not have.
    events: Vec<String>,
    diagnosis: Option<String>,
    log_path: Option<String>,
}

#[cfg(windows)]
mod experiment {
    use super::{Status, WATCHED};
    use std::sync::{Arc, Mutex};
    use tauri::{Emitter, Manager};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH, HBRUSH};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, GetClientRect, RegisterClassExW, SetWindowPos,
        HWND_BOTTOM, SWP_NOACTIVATE, SWP_SHOWWINDOW, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS,
        WS_VISIBLE,
    };

    /// The child window class. `wide()` keeps the UTF-16 alive for the call.
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        DefWindowProcW(h, m, w, l)
    }

    /// § step 3 — a SIBLING child HWND under the top-level window, below the
    /// webview in z-order.
    ///
    /// `WS_CLIPSIBLINGS` is not decoration: without it the two siblings paint
    /// over each other's rectangles and the result looks like a compositing
    /// failure that is really a painting bug — exactly the ambiguity this
    /// experiment cannot afford. `HWND_BOTTOM` puts mpv UNDER the webview,
    /// which is the entire arrangement under test.
    pub unsafe fn create_child(parent: HWND, diag: &Diag) -> Result<HWND, String> {
        let class = wide("LibertyExp1aVideo");
        let mut wc: WNDCLASSEXW = std::mem::zeroed();
        wc.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
        wc.lpfnWndProc = Some(proc);
        wc.hbrBackground = GetStockObject(BLACK_BRUSH) as HBRUSH;
        wc.lpszClassName = class.as_ptr();
        RegisterClassExW(&wc); // idempotent enough for a throwaway

        let mut rect = std::mem::zeroed();
        GetClientRect(parent, &mut rect);
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;

        /*
         * PL-0749. Recorded because the fix below cannot cover one case: if
         * the top-level window is not realised at Tauri `setup()` time,
         * GetClientRect legitimately answers zero, the child is created at
         * zero, and the symptom is identical to the bug being fixed. If that
         * is what happens, this line says so instead of the next run looking
         * like the last one.
         */
        diag.say(&format!(
            "parent client rect at create: {width}x{height}"
        ));
        if width <= 0 || height <= 0 {
            diag.say(
                "WARNING: the parent client area is ZERO at creation time. The child \
                 will be created with no area and mpv will report 1x1 even though the \
                 SetWindowPos defect below is fixed. fit_child after mpv init is the \
                 recovery for this.",
            );
        }

        let child = CreateWindowExW(
            0,
            class.as_ptr(),
            std::ptr::null(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            0,
            0,
            width,
            height,
            parent,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        if child.is_null() {
            return Err("CreateWindowExW returned null for the video child".into());
        }

        /*
         * THE DEFECT PL-0749 EXISTS FOR, AND IT COST A WHOLE ROUND.
         *
         * This call used to pass cx=0, cy=0 WITHOUT SWP_NOSIZE. SetWindowPos
         * honours a size it is given unless told not to, so the child created
         * at the client size one statement earlier was immediately resized to
         * nothing. mpv surfaces a zero-area window as "Window size: 1x1" --
         * which is exactly what the commander's log reported, under an
         * otherwise perfect run: file opened, HEVC detected, D3D11 up,
         * d3d11va decoding, gpu-next reporting 1920x1080 d3d11[nv12], first
         * frame rendered, playback completed. Everything worked and it was
         * drawn into a window with no area.
         *
         * The real dimensions are passed rather than SWP_NOSIZE added. Both
         * fix it; this one leaves no `0, 0, 0, 0` in the source for the next
         * reader to have to reason about, and it states the intent -- put the
         * video child at the origin, at the client size, at the bottom of the
         * z-order -- in the call itself.
         */
        SetWindowPos(
            child,
            HWND_BOTTOM,
            0,
            0,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        Ok(child)
    }

    /// Keeps the video child exactly over the client area. §10's resize and
    /// per-monitor-DPI criteria are about whether this stays true.
    pub unsafe fn fit_child(parent: HWND, child: HWND, diag: Option<&Diag>) {
        let mut rect = std::mem::zeroed();
        GetClientRect(parent, &mut rect);
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        /* `Some` only for the one call made deliberately after mpv init; the
         * resize and DPI handlers pass None, because a log line per drag
         * would bury the three lines that matter. */
        if let Some(diag) = diag {
            diag.say(&format!("fit_child: parent client rect is {width}x{height}"));
        }
        SetWindowPos(
            child,
            HWND_BOTTOM,
            0,
            0,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }

    /// mpv, owned by the Tauri state so the pause command can reach it.
    pub struct Player(pub Mutex<libmpv2::Mpv>);

    /* ====================================================================
     * PL-0748 — THE DIAGNOSTIC HALF
     *
     * The first real run produced a window, a rendered overlay, and no way
     * whatsoever to find out why nothing played. Everything below exists to
     * make the NEXT run answer that, and nothing below changes the
     * compositing arrangement that is actually under test.
     * ================================================================== */

    /// A log beside the exe, because `terminal=no` silences the console.
    ///
    /// Opened once, truncated per run, flushed per line. Best-effort: if it
    /// cannot be opened the experiment still runs, because a harness that
    /// refuses to start because it cannot write a log is worse than one that
    /// runs without it.
    pub struct Diag {
        file: Mutex<Option<std::fs::File>>,
        pub path: Option<String>,
    }

    impl Diag {
        pub fn open() -> Self {
            let path = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|dir| dir.join("exp-1a-diagnostic.log")));
            let file = path.as_ref().and_then(|p| std::fs::File::create(p).ok());
            Self {
                file: Mutex::new(file),
                path: path.map(|p| p.display().to_string()),
            }
        }

        pub fn say(&self, line: &str) {
            use std::io::Write;
            if let Ok(mut guard) = self.file.lock() {
                if let Some(file) = guard.as_mut() {
                    /* Per line, not at exit. The failure being chased might end
                     * the process, and a log flushed at exit is exactly the log
                     * that is empty when it matters -- the same reasoning
                     * PL-0734 recorded for the sidecar. */
                    let _ = writeln!(file, "{line}");
                    let _ = file.flush();
                }
            }
        }
    }

    /// mpv's own words for an error code.
    ///
    /// libmpv2's `Error` Displays as `Raw(-10)`, which is what the commander
    /// saw across several rows and which says nothing to anyone who has not
    /// memorised the table. `mpv_error_string` is the authoritative decoder
    /// and turns that into "property unavailable" -- which is the difference
    /// between "the harness is misusing the API" and "nothing is playing".
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

    /// Ask mpv for its log at a useful level.
    ///
    /// libmpv2 does not wrap this -- its own docs say "unimplemented" -- but
    /// `Mpv::ctx` is public, so the sys call is available. "v" is verbose:
    /// enough to show the demuxer, the decoder and the VO deciding what to
    /// do, without the per-frame volume of "debug".
    pub fn request_log(mpv: &libmpv2::Mpv, level: &str) -> Result<(), String> {
        let level = std::ffi::CString::new(level).map_err(|e| e.to_string())?;
        let rc = unsafe { libmpv2_sys::mpv_request_log_messages(mpv.ctx.as_ptr(), level.as_ptr()) };
        if rc < 0 {
            return Err(format!("mpv_request_log_messages returned {rc}"));
        }
        Ok(())
    }

    /// § step 4 — the exact initialisation the spec names, now narrated.
    ///
    /// The property set is UNCHANGED. The experiment is about this exact
    /// arrangement and a diagnostic round that quietly altered it would
    /// answer a different question than the one being asked.
    pub fn start(child: HWND, file: &str, diag: &Diag) -> Result<libmpv2::Mpv, String> {
        let wid = child as isize as i64;
        diag.say(&format!("child HWND wid = {wid} (0x{wid:x})"));

        /*
         * THE FILE, BEFORE mpv IS BLAMED FOR IT. "we passed the wrong string"
         * and "mpv refused the right one" produced identical symptoms on the
         * first run -- an idle core and an empty track-list -- so they are
         * separated here, on separate lines, before loadfile is called.
         */
        diag.say(&format!("file argument, {} bytes: {file:?}", file.len()));
        match std::fs::metadata(file) {
            Ok(meta) => diag.say(&format!(
                "the path EXISTS on disk: {} bytes, is_file={}",
                meta.len(),
                meta.is_file()
            )),
            Err(e) => diag.say(&format!(
                "the path DOES NOT RESOLVE from this process: {e}. \
                 If the file is really there, this is a quoting or \
                 working-directory problem and not an mpv problem."
            )),
        }

        let mpv = libmpv2::Mpv::with_initializer(|init| {
            init.set_property("wid", wid)?;
            init.set_property("vo", "gpu-next,gpu")?;
            init.set_property("gpu-context", "d3d11")?;
            init.set_property("hwdec", "auto")?;
            init.set_property("terminal", "no")?;
            init.set_property("osc", "no")?;
            init.set_property("input-default-bindings", "no")?;
            init.set_property("config", "no")?;
            Ok(())
        })
        .map_err(|e| format!("mpv_create/initialize failed: {}", explain(&e)))?;
        diag.say("mpv_create + mpv_initialize: OK");

        /*
         * BEFORE loadfile, so the log carries the demuxer and VO deciding what
         * to do rather than starting after they already have.
         */
        match request_log(&mpv, "v") {
            Ok(()) => diag.say("mpv_request_log_messages(\"v\"): OK"),
            Err(e) => diag.say(&format!("mpv_request_log_messages FAILED: {e}")),
        }

        /*
         * loadfile RETURNING Ok MEANS THE COMMAND WAS ACCEPTED, NOT THAT THE
         * FILE PLAYED. mpv loads asynchronously and reports the outcome as an
         * MPV_EVENT_END_FILE the first run never read, because nothing ever
         * drained the queue. That is why this says "accepted" and not "loaded".
         */
        match mpv.command("loadfile", &[file]) {
            Ok(()) => diag.say("loadfile ACCEPTED (queued; this is not yet playback)"),
            Err(e) => {
                let why = explain(&e);
                diag.say(&format!("loadfile REFUSED OUTRIGHT: {why}"));
                return Err(format!("loadfile {file} failed: {why}"));
            }
        }
        Ok(mpv)
    }

    fn read(mpv: &libmpv2::Mpv) -> Status {
        let mut status = Status::default();
        for name in WATCHED {
            // Read as a string: mpv types these differently and a debug
            // overlay does not need to know which is which.
            match mpv.get_property::<String>(name) {
                Ok(value) => {
                    status.properties.insert((*name).to_string(), value);
                }
                Err(error) => {
                    /* PL-0748: "<property unavailable (mpv error -10)>" rather
                     * than "<Raw(-10)>". The commander saw the latter on
                     * several rows and it reads like the harness is misusing
                     * the API, when in fact -10 is the ordinary answer for
                     * time-pos while nothing is playing. */
                    status
                        .properties
                        .insert((*name).to_string(), format!("<{}>", explain(&error)));
                }
            }
        }
        status
    }

    /// Drain mpv's event queue, recording everything.
    ///
    /// THE FIRST RUN NEVER DID THIS AT ALL, and that is why it could not
    /// explain itself: a file that fails to open reports through
    /// MPV_EVENT_END_FILE, and with nothing calling `wait_event` that event
    /// was produced and discarded unread. Log messages arrive the same way.
    ///
    /// `Event` derives `Debug`, so every variant is recorded verbatim --
    /// minimal to write and impossible to under-report, which matters when
    /// the interesting event is the one nobody predicted.
    ///
    /// Timeout 0.0 POLLS. A blocking wait here would hold the mutex that
    /// `toggle_pause` needs, and pass 3 of the experiment is whether that
    /// button works.
    fn drain(mpv: &libmpv2::Mpv, diag: &Diag, status: &mut Status) {
        while let Some(result) = mpv.wait_event(0.0) {
            let line = match &result {
                Ok(event) => format!("{event:?}"),
                Err(error) => format!("event error: {}", explain(error)),
            };
            diag.say(&format!("event: {line}"));

            /*
             * WHAT COUNTS AS THE ANSWER. EndFile carries the reason a file
             * stopped -- including failing to open -- and an mpv log line at
             * error or fatal level is mpv telling us directly. Those become
             * the overlay's diagnosis; everything else is still logged.
             */
            let interesting = match &result {
                Ok(libmpv2::events::Event::EndFile(reason)) => {
                    Some(format!("mpv ended the file: {reason:?}"))
                }
                Ok(libmpv2::events::Event::LogMessage { prefix, level, text, .. })
                    if matches!(*level, "error" | "fatal") =>
                {
                    Some(format!("mpv [{level}] {prefix}: {}", text.trim_end()))
                }
                Err(error) => Some(format!("mpv event error: {}", explain(error))),
                _ => None,
            };
            if let Some(found) = interesting {
                status.diagnosis = Some(found);
            }

            status.events.push(line);
            /* Bounded: the overlay is a panel, not a console, and the full
             * record is in the log file either way. */
            if status.events.len() > 40 {
                status.events.remove(0);
            }
        }
    }

    /// § step 5 — forward the properties to JS, live, and drain the events.
    ///
    /// Both happen on this one thread and under one lock acquisition. A
    /// second thread for the event queue would be the obvious shape and would
    /// contend with `toggle_pause` for the same mutex, which is the control
    /// pass 3 of the experiment is about.
    pub fn poll(app: tauri::AppHandle, player: Arc<Player>, diag: Arc<Diag>) {
        let mut carried: Option<String> = None;
        std::thread::spawn(move || loop {
            let mut status = match player.0.lock() {
                Ok(mpv) => {
                    let mut status = read(&mpv);
                    drain(&mpv, &diag, &mut status);
                    status
                }
                Err(_) => Status {
                    error: Some("the mpv handle is poisoned".into()),
                    ..Status::default()
                },
            };
            /* A diagnosis is sticky. The event that explains the failure
             * arrives once, early, and the overlay must still be showing it
             * when somebody looks up. */
            if status.diagnosis.is_some() {
                carried = status.diagnosis.clone();
            } else {
                status.diagnosis = carried.clone();
            }
            status.log_path = diag.path.clone();
            let _ = app.emit("exp1a://status", status);
            // ~10 Hz. "A usable rate" in the spec means a human can watch
            // avsync move; faster would only make the overlay the thing
            // under test.
            std::thread::sleep(std::time::Duration::from_millis(100));
        });
    }

    /// § step 6 — the HTML button toggles pause. If this command never fires,
    /// the child HWND ate the hit-testing, which is one of the pass criteria.
    #[tauri::command]
    pub fn toggle_pause(player: tauri::State<'_, Arc<Player>>) -> Result<bool, String> {
        let mpv = player.0.lock().map_err(|_| "mpv handle poisoned".to_string())?;
        let paused: bool = mpv.get_property("pause").map_err(|e| e.to_string())?;
        mpv.set_property("pause", !paused).map_err(|e| e.to_string())?;
        Ok(!paused)
    }

    pub fn run(file: String) {
        tauri::Builder::default()
            .invoke_handler(tauri::generate_handler![toggle_pause])
            .setup(move |app| {
                let window = app.get_webview_window("main").expect("main window");
                let parent = window.hwnd()?.0 as HWND;
                let diag = std::sync::Arc::new(Diag::open());
                diag.say(&format!(
                    "exp-1a diagnostic log (PL-0748). {}",
                    diag.path.as_deref().unwrap_or("(no path)")
                ));
                let child = unsafe { create_child(parent, &diag) }.map_err(std::io::Error::other)?;
                let mpv = start(child, &file, &diag).map_err(std::io::Error::other)?;
                /*
                 * PL-0749. ONCE, HERE, RATHER THAN WAITING FOR AN EVENT THAT
                 * MAY NEVER COME. fit_child was wired only to Resized and
                 * ScaleFactorChanged, and the commander never resized the
                 * window -- so the geometry set at creation was the geometry
                 * for the whole run, and when that was wrong nothing ever
                 * corrected it. Running it after mpv is up also re-reads the
                 * client rect at a moment when the top-level window is
                 * certainly realised.
                 */
                unsafe { fit_child(parent, child, Some(&diag)) };
                let player = std::sync::Arc::new(Player(Mutex::new(mpv)));
                app.manage(player.clone());
                poll(app.handle().clone(), player, diag);

                // Keep the video child matched to the client area through
                // resize and DPI changes — §10's two geometry criteria.
                //
                // The handle crosses into the closure as an `isize`, not as an
                // `HWND`. `on_window_event` requires `Send` and a raw pointer
                // is not; the alternative — a wrapper struct with an `unsafe
                // impl Send` — would be asserting thread-safety this
                // experiment has no business asserting. Tauri dispatches
                // window events on the thread that owns the window, which is
                // the only thread allowed to call `SetWindowPos` on it
                // anyway, so the integer round-trip is the honest encoding of
                // a fact the type system cannot see.
                let child_handle = child as isize;
                let handle = window.clone();
                window.on_window_event(move |event| {
                    if matches!(
                        event,
                        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
                    ) {
                        if let Ok(h) = handle.hwnd() {
                            unsafe { fit_child(h.0 as HWND, child_handle as HWND, None) };
                        }
                    }
                });
                Ok(())
            })
            .run(tauri::generate_context!())
            .expect("tauri run");
    }
}

fn main() {
    // The spec asks for a LOCAL 4K60 HEVC or AV1 file: local so there is no
    // network variable and no rights question, 4K60 HEVC/AV1 because the
    // hardware-decode criterion is the one that needs real work from the GPU.
    let file = std::env::args().nth(1).unwrap_or_default();
    if file.is_empty() {
        eprintln!(
            "exp-1a: pass the path to a LOCAL video file.\n\
             \n\
                 exp-1a.exe \"C:\\\\path\\\\to\\\\clip.mkv\"\n\
             \n\
             docs/DESKTOP_PLAYBACK.md section 10 asks for 4K60 HEVC or AV1. A smaller or\n\
             software-friendly clip will still show compositing, but it CANNOT test the\n\
             hardware-decode criterion, so a pass recorded from one would not be a pass."
        );
        std::process::exit(2);
    }

    #[cfg(windows)]
    experiment::run(file);

    #[cfg(not(windows))]
    {
        eprintln!(
            "exp-1a: this experiment is about WebView2, DWM and a child HWND. On {} there is \
             nothing for it to observe, and a run here would not be a weaker result — it would \
             be a different one wearing the same name.",
            std::env::consts::OS
        );
        std::process::exit(2);
    }
}
