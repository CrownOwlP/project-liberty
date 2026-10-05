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
const WATCHED: [&str; 7] = [
    "time-pos",
    "pause",
    "paused-for-cache",
    "cache-buffering-state",
    "avsync",
    "track-list",
    "hwdec-current",
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
    pub unsafe fn create_child(parent: HWND) -> Result<HWND, String> {
        let class = wide("LibertyExp1aVideo");
        let mut wc: WNDCLASSEXW = std::mem::zeroed();
        wc.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
        wc.lpfnWndProc = Some(proc);
        wc.hbrBackground = GetStockObject(BLACK_BRUSH) as HBRUSH;
        wc.lpszClassName = class.as_ptr();
        RegisterClassExW(&wc); // idempotent enough for a throwaway

        let mut rect = std::mem::zeroed();
        GetClientRect(parent, &mut rect);

        let child = CreateWindowExW(
            0,
            class.as_ptr(),
            std::ptr::null(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            0,
            0,
            rect.right - rect.left,
            rect.bottom - rect.top,
            parent,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        if child.is_null() {
            return Err("CreateWindowExW returned null for the video child".into());
        }
        SetWindowPos(child, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        Ok(child)
    }

    /// Keeps the video child exactly over the client area. §10's resize and
    /// per-monitor-DPI criteria are about whether this stays true.
    pub unsafe fn fit_child(parent: HWND, child: HWND) {
        let mut rect = std::mem::zeroed();
        GetClientRect(parent, &mut rect);
        SetWindowPos(
            child,
            HWND_BOTTOM,
            0,
            0,
            rect.right - rect.left,
            rect.bottom - rect.top,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }

    /// mpv, owned by the Tauri state so the pause command can reach it.
    pub struct Player(pub Mutex<libmpv2::Mpv>);

    /// § step 4 — the exact initialisation the spec names.
    pub fn start(child: HWND, file: &str) -> Result<libmpv2::Mpv, String> {
        let wid = child as isize as i64;
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
        .map_err(|e| format!("mpv_create/initialize failed: {e}"))?;
        mpv.command("loadfile", &[file])
            .map_err(|e| format!("loadfile {file} failed: {e}"))?;
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
                    status.properties.insert((*name).to_string(), format!("<{error}>"));
                }
            }
        }
        status
    }

    /// § step 5 — forward the properties to JS, live.
    pub fn poll(app: tauri::AppHandle, player: Arc<Player>) {
        std::thread::spawn(move || loop {
            let status = match player.0.lock() {
                Ok(mpv) => read(&mpv),
                Err(_) => Status {
                    error: Some("the mpv handle is poisoned".into()),
                    ..Status::default()
                },
            };
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
                let child = unsafe { create_child(parent) }.map_err(std::io::Error::other)?;
                let mpv = start(child, &file).map_err(std::io::Error::other)?;
                let player = std::sync::Arc::new(Player(Mutex::new(mpv)));
                app.manage(player.clone());
                poll(app.handle().clone(), player);

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
                            unsafe { fit_child(h.0 as HWND, child_handle as HWND) };
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
