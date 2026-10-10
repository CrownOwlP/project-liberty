//! The host window, the message loop, and the input forwarding that a
//! composition-hosted webview cannot do for itself.
//!
//! EVERYTHING RUNS ON ONE THREAD, and that is a decision rather than an
//! accident. WebView2's COM objects live in a single-threaded apartment, so a
//! background thread polling mpv and then calling `PostWebMessageAsJson` would
//! be a marshalling bug waiting for a slow frame. The mpv poll is therefore a
//! `WM_TIMER` on the same thread as everything else. It costs nothing at 10 Hz
//! and removes a whole class of failure that would be indistinguishable from
//! the one under test.

use crate::dcomp::Tree;
use crate::diag::Diag;
use crate::player;
use crate::web::Web;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_MOUSE_EVENT_KIND, COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
    COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN, COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP,
    COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE, COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN,
    COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP, COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL,
};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
// WM_MOUSELEAVE is in UI::Controls and TrackMouseEvent in
// UI::Input::KeyboardAndMouse. They are imported BY NAME and not reached
// through a glob, because an un-imported WM_* in a match arm is an irrefutable
// binding that silently matches every message -- which is exactly the bug the
// compiler caught here on the first build of this file.
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::WM_MOUSELEAVE;
use windows::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT};
use windows::Win32::UI::WindowsAndMessaging::*;

/// 10 Hz. Criterion 7 asks that `time-pos` and `avsync` stream "at a usable
/// rate"; 10 Hz is what Experiment 1a used and what a human reads comfortably.
const POLL_MS: u32 = 100;
const TIMER_ID: usize = 1;

/// How many polls to wait for mpv's composition swapchain before saying so.
/// The VO comes up lazily after `loadfile`, so `None` is normal at first --
/// but silence forever is the failure Experiment 1a taught us to name.
const SWAPCHAIN_PATIENCE: u32 = 50; // ~5 seconds

struct State {
    diag: std::rc::Rc<Diag>,
    tree: Tree,
    web: Web,
    mpv: libmpv2::Mpv,
    /// Set once mpv's swapchain has been attached to the video visual.
    attached: bool,
    polls_without_swapchain: u32,
    /// Pending request from the page, consumed by the next timer tick. The
    /// web-message handler must not call into mpv directly: it fires inside
    /// WebView2's own callback, and re-entering the player from there is how a
    /// deadlock gets mistaken for a compositing failure.
    toggle_requested: std::rc::Rc<std::cell::Cell<bool>>,
    client: (i32, i32),
    /// Whether a `TME_LEAVE` request is outstanding. Windows consumes the
    /// request when it fires, so it has to be re-armed on the next move.
    tracking_leave: bool,
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Build everything, then pump messages until the window closes.
pub fn run(file: &str) -> Result<(), String> {
    let diag = std::rc::Rc::new(Diag::open());
    diag.say(&format!(
        "exp-1c diagnostic log (PL-0752, DirectComposition arrangement). {}",
        diag.path.as_deref().unwrap_or("(no path)")
    ));
    diag.say(
        "READ THE FIRST FAIL LINE. Every construction step below reports its own outcome, so a \
         run that shows nothing says WHERE it stopped. A run with no FAIL line and still no \
         video is the real result this experiment exists to produce.",
    );

    // Apartment-threaded, because WebView2's objects are. Must come before any
    // COM object is created.
    diag.step("CoInitializeEx(APARTMENTTHREADED)");
    let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if com.is_err() {
        return Err(format!("CoInitializeEx failed: {com:?}"));
    }
    diag.ok("COM initialised");

    // Before the window exists, so the window is created at the right scale.
    // Criterion 6 cannot be observed from a DPI-unaware process: Windows would
    // lie to us about every coordinate.
    diag.step("SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)");
    match unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) } {
        Ok(()) => diag.ok("per-monitor DPI v2"),
        Err(e) => diag.fail(&format!(
            "DPI awareness could not be set: {e}. Criterion 6 cannot be judged on this run; the \
             others are unaffected."
        )),
    }

    let hwnd = create_window(&diag)?;
    let (width, height) = client_size(hwnd);
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    let scale = if dpi == 0 { 1.0 } else { dpi as f32 / 96.0 };
    diag.say(&format!(
        "host window client area {width}x{height} at {dpi} dpi (scale {scale})"
    ));
    if width <= 0 || height <= 0 {
        diag.fail(
            "the host window has ZERO client area. Experiment 1a lost a whole round to exactly \
             this, so it is checked here rather than discovered later.",
        );
        return Err("the host window has no client area".into());
    }

    let tree = Tree::create(hwnd, &diag)?;
    let web = Web::create(hwnd, &tree, width, height, scale, &diag)?;

    let toggle_requested = std::rc::Rc::new(std::cell::Cell::new(false));
    {
        let flag = std::rc::Rc::clone(&toggle_requested);
        let diag_for_handler = std::rc::Rc::clone(&diag);
        web.on_web_message(&diag, move |message| {
            /*
             * The page now posts JSON so it can report more than one thing.
             * Matched by substring rather than parsed, because this experiment
             * has 24 crates in its whole graph and that is a property worth
             * keeping: the two shapes the page can send are known and small,
             * and adding serde to a throwaway to read them would not be.
             */
            if message.contains("\"toggle-pause\"") {
                diag_for_handler
                    .say("the page asked for toggle-pause (criterion 3: input arrived)");
                flag.set(true);
            } else if message.contains("\"page-alive\"") {
                /*
                 * THE SIGNAL THE FIRST RUN LACKED. A successful
                 * NavigationCompleted proves the document loaded; this proves
                 * the page's own SCRIPT ran, and it carries the viewport size,
                 * so "rendered into a zero-area viewport" and "rendered
                 * correctly but hidden behind the video" become different
                 * lines instead of the same empty window.
                 */
                diag_for_handler.ok(&format!("the page reported itself ALIVE: {message}"));
            } else {
                diag_for_handler.say(&format!(
                    "the page posted an unexpected message: {message:?}"
                ));
            }
        })?;
    }
    // BEFORE navigate, so the first navigation cannot complete unobserved.
    web.on_load(&diag, std::rc::Rc::clone(&diag))?;
    web.navigate(&diag)?;

    let mpv = player::start(file, width, height, &diag)?;

    // Visible last, so the first thing drawn is the finished tree rather than
    // an empty webview over nothing.
    diag.step("show the window");
    let _ = unsafe { ShowWindow(hwnd, SW_SHOW) };
    tree.commit()?;
    diag.ok("window shown and the tree committed");

    let state = Box::new(State {
        diag: std::rc::Rc::clone(&diag),
        tree,
        web,
        mpv,
        attached: false,
        polls_without_swapchain: 0,
        toggle_requested,
        client: (width, height),
        tracking_leave: false,
    });
    unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(state) as isize) };

    unsafe { SetTimer(Some(hwnd), TIMER_ID, POLL_MS, None) };
    diag.say("--- setup complete; entering the message loop ---");

    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }

    diag.say("--- the message loop ended ---");
    // Criterion 8. Explicit teardown in a known order: the webview first, then
    // mpv (whose Drop calls mpv_terminate_destroy), then the visual tree, then
    // COM. Leaving this to drop order at process exit is where an orphaned
    // msedgewebview2.exe comes from.
    let state = unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) } as *mut State;
    if !state.is_null() {
        let state = unsafe { Box::from_raw(state) };
        state.web.close(&diag);
        diag.step("drop mpv (mpv_terminate_destroy)");
        drop(state);
        diag.ok("mpv and the visual tree are released");
    }
    unsafe { CoUninitialize() };
    diag.say("clean exit. If Task Manager still shows exp-1c.exe or msedgewebview2.exe, that is criterion 8 failing.");
    Ok(())
}

fn create_window(diag: &Diag) -> Result<HWND, String> {
    diag.step("RegisterClassExW + CreateWindowExW");
    let class = wide("LibertyExp1cHost");
    let instance =
        unsafe { GetModuleHandleW(None) }.map_err(|e| format!("GetModuleHandleW: {e}"))?;
    let mut wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(proc),
        hInstance: instance.into(),
        lpszClassName: PCWSTR(class.as_ptr()),
        hCursor: unsafe { LoadCursorW(None, IDC_ARROW) }.unwrap_or_default(),
        ..Default::default()
    };
    // NO BACKGROUND BRUSH, deliberately. The window paints nothing: everything
    // visible is a DirectComposition visual. A brush here would paint over the
    // tree on every WM_ERASEBKGND and look exactly like a compositing failure.
    wc.hbrBackground = Default::default();
    if unsafe { RegisterClassExW(&wc) } == 0 {
        return Err("RegisterClassExW failed".into());
    }

    let title = wide("Experiment 1c - DirectComposition (mpv below, WebView2 above)");
    // 1280x720 CLIENT area, computed rather than assumed, so the dashed frame
    // in the page and the video's own geometry can be compared honestly.
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 1280,
        bottom: 720,
    };
    let _ =
        unsafe { AdjustWindowRectEx(&mut rect, WS_OVERLAPPEDWINDOW, false, WINDOW_EX_STYLE(0)) };

    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class.as_ptr()),
            PCWSTR(title.as_ptr()),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            rect.right - rect.left,
            rect.bottom - rect.top,
            None,
            None,
            Some(instance.into()),
            None,
        )
    }
    .map_err(|e| format!("CreateWindowExW failed: {e}"))?;
    diag.ok("host window created (hidden until the tree is built)");
    Ok(hwnd)
}

fn client_size(hwnd: HWND) -> (i32, i32) {
    let mut rect = RECT::default();
    let _ = unsafe { GetClientRect(hwnd, &mut rect) };
    (rect.right - rect.left, rect.bottom - rect.top)
}

fn state_of(hwnd: HWND) -> Option<&'static mut State> {
    let pointer = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut State;
    if pointer.is_null() {
        None
    } else {
        Some(unsafe { &mut *pointer })
    }
}

/// `lparam` carries client-relative x and y for every `WM_MOUSE*` except
/// `WM_MOUSEWHEEL`, whose coordinates are SCREEN-relative. Getting that wrong
/// sends every wheel event to the wrong place, which wry#1762 flags from
/// production experience and which is why the conversion is explicit here.
fn mouse_point(hwnd: HWND, lparam: LPARAM, screen_relative: bool) -> POINT {
    let raw = lparam.0 as u32;
    let mut point = POINT {
        x: (raw & 0xFFFF) as i16 as i32,
        y: ((raw >> 16) & 0xFFFF) as i16 as i32,
    };
    if screen_relative {
        let _ = unsafe { ScreenToClient(hwnd, &mut point) };
    }
    point
}

fn mouse_kind(message: u32) -> Option<(COREWEBVIEW2_MOUSE_EVENT_KIND, bool)> {
    Some(match message {
        WM_MOUSEMOVE => (COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE, false),
        WM_LBUTTONDOWN => (COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN, false),
        WM_LBUTTONUP => (COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP, false),
        WM_RBUTTONDOWN => (COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN, false),
        WM_RBUTTONUP => (COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP, false),
        WM_MOUSELEAVE => (COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE, false),
        WM_MOUSEWHEEL => (COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL, true),
        _ => return None,
    })
}

unsafe extern "system" fn proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // INPUT FORWARDING. A composition-hosted webview receives nothing from
    // Windows because it has no window, so criterion 3 lives or dies here.
    if let Some((kind, screen_relative)) = mouse_kind(message) {
        if let Some(state) = state_of(hwnd) {
            let point = mouse_point(hwnd, lparam, screen_relative);
            let data = if message == WM_MOUSEWHEEL {
                ((wparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32 as u32
            } else {
                0
            };
            state.web.send_mouse(kind, data, point);
            // Focus on press, not per keystroke: WebView2 keeps a hidden
            // input HWND that then takes real Win32 focus.
            if message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN {
                state.web.move_focus();
            }
            // Windows only sends WM_MOUSELEAVE if it was asked to, once per
            // entry. Without it the webview's :hover states stick after the
            // pointer leaves -- a visible artefact that could be mistaken for
            // a compositing fault.
            if message == WM_MOUSEMOVE && !state.tracking_leave {
                let mut track = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                if unsafe { TrackMouseEvent(&mut track) }.is_ok() {
                    state.tracking_leave = true;
                }
            }
            if message == WM_MOUSELEAVE {
                state.tracking_leave = false;
            }
            // A move is still passed to DefWindowProcW below so the window
            // keeps behaving like a window; the others are consumed.
            if message != WM_MOUSEMOVE {
                return LRESULT(0);
            }
        }
    }

    match message {
        WM_SETFOCUS => {
            if let Some(state) = state_of(hwnd) {
                state.web.move_focus();
            }
            LRESULT(0)
        }
        WM_SETCURSOR => {
            // With no window of its own WebView2 cannot set the cursor, so the
            // host applies whatever it last asked for. Over the client area
            // only; the frame keeps its normal sizing cursors.
            if (lparam.0 as u32 & 0xFFFF) == HTCLIENT {
                if let Some(state) = state_of(hwnd) {
                    let cursor = state.web.cursor.get();
                    if !cursor.0.is_null() {
                        unsafe { SetCursor(Some(cursor)) };
                        return LRESULT(1);
                    }
                }
            }
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }
        WM_SIZE => {
            // CRITERION 5. Both layers are resized from one place in one
            // order, which is the point of having one tree: mpv's composition
            // size, then the webview's bounds, then a single Commit.
            if let Some(state) = state_of(hwnd) {
                let (width, height) = client_size(hwnd);
                if width > 0 && height > 0 && (width, height) != state.client {
                    state.client = (width, height);
                    if let Err(error) = player::resize(&state.mpv, width, height) {
                        state
                            .diag
                            .fail(&format!("resize: mpv refused {width}x{height}: {error}"));
                    }
                    state.web.set_bounds(width, height);
                    if let Err(error) = state.tree.commit() {
                        state.diag.fail(&format!("resize: {error}"));
                    }
                    state.diag.say(&format!("resized to {width}x{height}"));
                }
            }
            LRESULT(0)
        }
        WM_MOVE => {
            if let Some(state) = state_of(hwnd) {
                state.web.parent_moved();
            }
            LRESULT(0)
        }
        WM_DPICHANGED => {
            // CRITERION 6. Windows hands us the rect it wants; we take it, and
            // then tell WebView2 the new scale because it cannot see the
            // change itself.
            if let Some(state) = state_of(hwnd) {
                let dpi = (wparam.0 & 0xFFFF) as u32;
                let scale = if dpi == 0 { 1.0 } else { dpi as f32 / 96.0 };
                let suggested = lparam.0 as *const RECT;
                if !suggested.is_null() {
                    let r = unsafe { *suggested };
                    let _ = unsafe {
                        SetWindowPos(
                            hwnd,
                            None,
                            r.left,
                            r.top,
                            r.right - r.left,
                            r.bottom - r.top,
                            SWP_NOZORDER | SWP_NOACTIVATE,
                        )
                    };
                }
                state.web.set_scale(scale);
                state
                    .diag
                    .say(&format!("DPI changed to {dpi} (scale {scale})"));
            }
            LRESULT(0)
        }
        WM_TIMER => {
            if let Some(state) = state_of(hwnd) {
                tick(state);
            }
            LRESULT(0)
        }
        WM_ERASEBKGND => {
            // The window paints nothing. Claiming the erase stops Windows
            // filling the client area and flashing over the visual tree.
            LRESULT(1)
        }
        WM_CLOSE => {
            unsafe { DestroyWindow(hwnd) }.ok();
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe { KillTimer(Some(hwnd), TIMER_ID) }.ok();
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

/// One poll: honour a pending pause request, attach the swapchain the first
/// time it appears, read the watched properties, drain mpv's events, and push
/// the lot to the page.
fn tick(state: &mut State) {
    if state.toggle_requested.replace(false) {
        match state.mpv.get_property::<bool>("pause") {
            Ok(paused) => match state.mpv.set_property("pause", !paused) {
                Ok(()) => state
                    .diag
                    .say(&format!("toggle-pause: mpv pause is now {}", !paused)),
                Err(error) => state.diag.fail(&format!(
                    "toggle-pause: mpv REFUSED the new pause value: {}",
                    player::explain(&error)
                )),
            },
            Err(error) => state.diag.fail(&format!(
                "toggle-pause: could not read pause: {}",
                player::explain(&error)
            )),
        }
    }

    // THE ONE STEP THAT CANNOT HAPPEN DURING SETUP. mpv creates its VO lazily
    // after loadfile, so `display-swapchain` is unavailable until the first
    // frame needs it. Polling is correct; silence forever is the failure.
    if !state.attached {
        match player::display_swapchain(&state.mpv) {
            Ok(Some(swapchain)) => {
                state.diag.say(&format!(
                    "mpv published its composition swapchain after {} polls",
                    state.polls_without_swapchain
                ));
                match state.tree.attach_video(swapchain, &state.diag) {
                    Ok(()) => {
                        state.attached = true;
                        state.diag.say(
                            "--- THE ARRANGEMENT IS NOW COMPLETE. Everything from here is what \
                             the commander can see. ---",
                        );
                    }
                    Err(error) => {
                        state.attached = true; // do not retry a hard failure every 100ms
                        state.diag.fail(&error);
                        state.web.post(&format!(
                            "{{\"error\":{}}}",
                            json_string(&format!(
                                "DirectComposition refused mpv's swapchain: {error}"
                            ))
                        ));
                    }
                }
            }
            Ok(None) => {
                state.polls_without_swapchain += 1;
                if state.polls_without_swapchain == SWAPCHAIN_PATIENCE {
                    let message = format!(
                        "mpv has not published a composition swapchain after {} polls (~{} ms). \
                         Either no video output came up at all -- check current-vo and \
                         vo-configured below, and mpv's own log lines above -- or this libmpv \
                         build does not support --d3d11-output-mode=composition. Either way the \
                         experiment CANNOT be judged on this run.",
                        SWAPCHAIN_PATIENCE,
                        SWAPCHAIN_PATIENCE * POLL_MS
                    );
                    state.diag.fail(&message);
                    state
                        .web
                        .post(&format!("{{\"error\":{}}}", json_string(&message)));
                }
            }
            Err(error) => {
                state.attached = true;
                state.diag.fail(&format!(
                    "reading display-swapchain failed outright: {error}"
                ));
            }
        }
    }

    // CRITERION 7. The properties, as the page will show them.
    let mut rows = String::from("[");
    for (index, name) in player::WATCHED.iter().enumerate() {
        if index > 0 {
            rows.push(',');
        }
        let value = match state.mpv.get_property::<String>(name) {
            Ok(value) => value,
            // -10 is the ORDINARY answer while nothing is playing. Saying so
            // in words is what Experiment 1a's first run needed and lacked.
            Err(libmpv2::Error::Raw(-10)) => "(unavailable while idle)".to_string(),
            Err(error) => player::explain(&error),
        };
        rows.push_str(&format!("[{},{}]", json_string(name), json_string(&value)));
    }
    rows.push(']');
    state.web.post(&format!("{{\"props\":{rows}}}"));

    drain(state);
}

/// mpv reports a file that failed to open as an event, not as an error from
/// `loadfile`. Experiment 1a discarded those unread for a whole round.
fn drain(state: &mut State) {
    while let Some(result) = state.mpv.wait_event(0.0) {
        match &result {
            Ok(libmpv2::events::Event::LogMessage {
                prefix,
                level,
                text,
                ..
            }) => {
                state
                    .diag
                    .say(&format!("mpv [{level}] {prefix}: {}", text.trim_end()));
            }
            Ok(libmpv2::events::Event::EndFile(reason)) => {
                state.diag.say(&format!("mpv ended the file: {reason:?}"));
            }
            Ok(event) => state.diag.say(&format!("mpv event: {event:?}")),
            Err(error) => state
                .diag
                .fail(&format!("mpv event error: {}", player::explain(error))),
        }
    }
}

/// Minimal JSON string escaping. A dependency for this would be a dependency
/// in a throwaway, and mpv property values are external strings that must not
/// be able to break the page's parser.
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
