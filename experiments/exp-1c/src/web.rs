//! The WebView2 side: a COMPOSITION controller, not a windowed one.
//!
//! THE STRUCTURAL FACT THIS MODULE EXISTS FOR. A composition-hosted webview
//! must be created through
//! `ICoreWebView2Environment3::CreateCoreWebView2CompositionController`
//! INSTEAD OF `CreateCoreWebView2Controller`. It is a creation-time choice
//! with no post-hoc conversion, which is why Tauri -- whose webview is always
//! created windowed and handed out afterwards through `with_webview` -- cannot
//! be made to do this from outside, and why `tauri-apps/wry#1762` is a change
//! inside wry.
//!
//! TWO CONSEQUENCES THE HOST HAS TO ABSORB, both of which wry#1762 documents
//! from production use and which are cited here rather than vendored:
//!
//! 1. **A composition-hosted webview receives no input from Windows**, because
//!    it has no window to receive it. The host forwards mouse messages to
//!    `SendMouseInput`, and calls `MoveFocus(PROGRAMMATIC)` on mouse-down and
//!    focus rather than forwarding keystrokes one by one -- WebView2 keeps a
//!    hidden input HWND that takes real Win32 focus. Experiment 1c's criterion
//!    3 (clickable HTML controls) rests entirely on this.
//! 2. **It cannot detect a DPI change**, for the same reason, so the host sets
//!    `RasterizationScale` itself and turns `ShouldDetectMonitorScaleChanges`
//!    off. That is criterion 6.
//!
//! Touch and pen (`SendPointerInput`) are deliberately NOT implemented. wry's
//! own PR calls its touch path best-effort with zeroed himetric fields, and
//! none of the eight criteria is about touch. Leaving it out is honest; a
//! half-working path that nobody tested would be a second variable.

use crate::dcomp::Tree;
use crate::diag::Diag;
use std::sync::mpsc;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    CreateCoreWebView2CompositionControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, DOMContentLoadedEventHandler,
    NavigationCompletedEventHandler, WebMessageReceivedEventHandler,
};
use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::Foundation::{E_POINTER, HWND, POINT, RECT};

/// The HTML. Embedded in the exe and navigated to with `NavigateToString`
/// rather than loaded from a file, so there is no file path to get wrong, no
/// working-directory dependency and no custom scheme -- three things that
/// could each imitate a compositing failure.
///
/// The page is the test for criterion 2: `--tint` is a translucent gradient
/// over the whole viewport, so if composition works the video is visibly
/// COLOURED by it rather than hidden behind it. The body background is
/// `transparent`, which only shows the video through if
/// `DefaultBackgroundColor` really took.
const PAGE: &str = include_str!("page.html");

pub struct Web {
    pub composition: ICoreWebView2CompositionController,
    pub controller: ICoreWebView2Controller,
    pub core: ICoreWebView2,
    /// The last cursor WebView2 asked for. Applied on `WM_SETCURSOR`, because
    /// with no window of its own WebView2 cannot set the cursor itself.
    pub cursor: std::cell::Cell<windows::Win32::UI::WindowsAndMessaging::HCURSOR>,
}

impl Web {
    /// Create the environment and the composition controller, synchronously.
    ///
    /// `wait_for_async_operation` pumps the message loop until the callback
    /// fires, which is what lets setup read as a sequence instead of a state
    /// machine. It is only safe because nothing else is running yet.
    pub fn create(
        hwnd: HWND,
        tree: &Tree,
        width: i32,
        height: i32,
        dpi_scale: f32,
        diag: &Diag,
    ) -> Result<Self, String> {
        diag.step("CreateCoreWebView2EnvironmentWithOptions");
        let environment = {
            let (tx, rx) = mpsc::channel();
            CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
                Box::new(move |handler| unsafe {
                    // A user-data folder beside the exe keeps the run
                    // self-contained and leaves no trace in the commander's
                    // profile. A throwaway should not install itself.
                    let folder = std::env::current_exe()
                        .ok()
                        .and_then(|exe| exe.parent().map(|dir| dir.join("exp-1c-webview2")))
                        .map(|p| HSTRING::from(p.as_os_str()))
                        .unwrap_or_default();
                    CreateCoreWebView2EnvironmentWithOptions(
                        PCWSTR::null(),
                        PCWSTR(folder.as_ptr()),
                        None,
                        &handler,
                    )
                    .map_err(webview2_com::Error::WindowsError)
                }),
                Box::new(move |code, environment| {
                    code?;
                    tx.send(environment.ok_or_else(|| windows::core::Error::from(E_POINTER)))
                        .expect("send over mpsc channel");
                    Ok(())
                }),
            )
            .map_err(|e| {
                format!(
                    "creating the WebView2 environment failed: {e:?}. The WebView2 Evergreen \
                     runtime is probably not installed, and the experiment CANNOT be judged on \
                     this run."
                )
            })?;
            rx.recv()
                .map_err(|_| "the WebView2 environment callback never fired".to_string())?
                .map_err(|e| format!("the WebView2 environment is an error: {e}"))?
        };
        diag.ok("WebView2 environment created");

        diag.step("query the environment for ICoreWebView2Environment3");
        let environment3: ICoreWebView2Environment3 = environment.cast().map_err(|e| {
            format!(
                "ICoreWebView2Environment3 is NOT AVAILABLE: {e}. Composition hosting does not \
                 exist below environment version 3, so this WebView2 runtime is too old for the \
                 arrangement under test. This is a RUNTIME VERSION result, not a compositing \
                 result -- update the WebView2 Evergreen runtime and re-run."
            )
        })?;
        diag.ok("ICoreWebView2Environment3 obtained: composition hosting is available");

        diag.step("CreateCoreWebView2CompositionController");
        let composition = {
            let (tx, rx) = mpsc::channel();
            CreateCoreWebView2CompositionControllerCompletedHandler::wait_for_async_operation(
                Box::new(move |handler| unsafe {
                    environment3
                        .CreateCoreWebView2CompositionController(hwnd, &handler)
                        .map_err(webview2_com::Error::WindowsError)
                }),
                Box::new(move |code, controller| {
                    code?;
                    tx.send(controller.ok_or_else(|| windows::core::Error::from(E_POINTER)))
                        .expect("send over mpsc channel");
                    Ok(())
                }),
            )
            .map_err(|e| format!("CreateCoreWebView2CompositionController failed: {e:?}"))?;
            rx.recv()
                .map_err(|_| "the composition-controller callback never fired".to_string())?
                .map_err(|e| format!("the composition controller is an error: {e}"))?
        };
        diag.ok("ICoreWebView2CompositionController created -- the webview has NO window");

        diag.step("SetRootVisualTarget(the TOP visual of the DComp tree)");
        unsafe { composition.SetRootVisualTarget(&tree.web) }.map_err(|e| {
            format!(
                "SetRootVisualTarget failed: {e}. The webview exists but is not attached to the \
                 visual tree, so nothing it renders can appear."
            )
        })?;
        diag.ok("the webview now renders into the top visual");
        /*
         * REQUIRED, AND THE HARNESS WAS NOT DOING IT. Microsoft's
         * RootVisualTarget reference: "The app needs to commit on its device
         * setting the RootVisualTarget property", and their sample calls
         * Commit immediately after. Before this the next commit came only when
         * mpv's swapchain arrived -- about a second later, and never at all if
         * it did not arrive -- which would leave the webview unattached for a
         * reason no log line named.
         */
        tree.commit_named("SetRootVisualTarget", diag);

        diag.step("query the composition controller for ICoreWebView2Controller");
        let controller: ICoreWebView2Controller = composition.cast().map_err(|e| {
            format!("the composition controller is not an ICoreWebView2Controller: {e}")
        })?;
        diag.ok("ICoreWebView2Controller obtained");

        /*
         * TRANSPARENCY, AGAIN -- BUT THIS TIME WITH SOMETHING BENEATH IT.
         * Experiment 1a made this exact call successfully and the video stayed
         * invisible, because the thing beneath was another WINDOW. Here the
         * thing beneath is a sibling visual in the same tree, which is the
         * difference the whole experiment turns on. The alpha value is
         * restricted to exactly 0 or 255 -- anything else returns
         * E_INVALIDARG -- and at A=0 Microsoft's reference says the hosting
         * app's background content is rendered instead.
         */
        diag.step("ICoreWebView2Controller2::SetDefaultBackgroundColor(0, 0, 0, 0)");
        match controller.cast::<ICoreWebView2Controller2>() {
            Ok(controller2) => {
                let clear = COREWEBVIEW2_COLOR {
                    A: 0,
                    R: 0,
                    G: 0,
                    B: 0,
                };
                match unsafe { controller2.SetDefaultBackgroundColor(clear) } {
                    Ok(()) => diag.ok("the webview paints no background of its own"),
                    Err(e) => diag.fail(&format!(
                        "SetDefaultBackgroundColor FAILED: {e}. The webview will paint an opaque \
                         background over the video visual and criterion 2 CANNOT pass."
                    )),
                }
            }
            Err(e) => diag.fail(&format!(
                "ICoreWebView2Controller2 is NOT AVAILABLE: {e}. This runtime predates \
                 DefaultBackgroundColor and criterion 2 CANNOT pass on it."
            )),
        }

        /*
         * DPI, WHICH IS CRITERION 6 AND WHICH THIS ARRANGEMENT MAKES THE
         * HOST'S JOB. A windowed WebView2 watches its own window move between
         * monitors. A composition-hosted one has no window, so
         * ShouldDetectMonitorScaleChanges is turned OFF and the host sets the
         * scale from WM_DPICHANGED. Bounds are then RAW PIXELS, because the
         * host is already working in them.
         */
        diag.step(&format!(
            "ICoreWebView2Controller3: rasterization scale {dpi_scale}"
        ));
        match controller.cast::<ICoreWebView2Controller3>() {
            Ok(controller3) => {
                let mut notes = Vec::new();
                if let Err(e) = unsafe { controller3.SetShouldDetectMonitorScaleChanges(false) } {
                    notes.push(format!("ShouldDetectMonitorScaleChanges: {e}"));
                }
                if let Err(e) = unsafe { controller3.SetRasterizationScale(dpi_scale as f64) } {
                    notes.push(format!("RasterizationScale: {e}"));
                }
                if let Err(e) =
                    unsafe { controller3.SetBoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS) }
                {
                    notes.push(format!("BoundsMode: {e}"));
                }
                if notes.is_empty() {
                    diag.ok("the host owns the rasterization scale; bounds are raw pixels");
                } else {
                    diag.fail(&format!(
                        "some DPI configuration did not take ({}). Criterion 6 is at risk; \
                         criterion 2 is not affected.",
                        notes.join("; ")
                    ));
                }
            }
            Err(e) => diag.fail(&format!(
                "ICoreWebView2Controller3 is NOT AVAILABLE: {e}. The host cannot set the \
                 rasterization scale, so criterion 6 CANNOT pass. Criterion 2 is not affected."
            )),
        }

        /*
         * IsVisible WAS NEVER SET, AND ITS DEFAULT IS NOT DOCUMENTED.
         * ICoreWebView2Controller's reference says only that "If IsVisible is
         * set to FALSE, the WebView2 is transparent and is not rendered" and
         * states no default for a composition-hosted controller. An invisible
         * webview and a webview hidden behind the video produce the SAME
         * symptom -- video playing, no HTML -- so this reads the value first
         * and logs it, which settles on the commander's machine what the
         * documentation does not say, and then sets it regardless.
         */
        diag.step("ICoreWebView2Controller::IsVisible");
        let mut visible = windows::core::BOOL(0);
        match unsafe { controller.IsVisible(&mut visible) } {
            Ok(()) => diag.say(&format!(
                "  ..  IsVisible READ AS {} BEFORE being set. If that is false, it was the \
                 whole problem; if true, the webview was already meant to be rendering.",
                visible.as_bool()
            )),
            Err(e) => diag.fail(&format!("could not READ IsVisible: {e}")),
        }
        match unsafe { controller.SetIsVisible(true) } {
            Ok(()) => diag.ok("IsVisible set to true"),
            Err(e) => diag.fail(&format!(
                "SetIsVisible(true) FAILED: {e}. The webview will not render and criterion 2 \
                 CANNOT pass."
            )),
        }

        diag.step(&format!("SetBounds 0,0 {width}x{height}"));
        unsafe {
            controller.SetBounds(RECT {
                left: 0,
                top: 0,
                right: width,
                bottom: height,
            })
        }
        .map_err(|e| format!("SetBounds failed: {e}"))?;
        diag.ok("bounds set");

        diag.step("CoreWebView2 + settings");
        let core = unsafe { controller.CoreWebView2() }
            .map_err(|e| format!("CoreWebView2 unavailable: {e}"))?;
        let settings = unsafe { core.Settings() }
            .map_err(|e| format!("CoreWebView2 settings unavailable: {e}"))?;
        // The only channel the page needs: post a message to pause, receive
        // telemetry. No custom scheme, no local server, no Tauri IPC.
        unsafe { settings.SetIsWebMessageEnabled(true) }
            .map_err(|e| format!("SetIsWebMessageEnabled failed: {e}"))?;
        let _ = unsafe { settings.SetAreDefaultContextMenusEnabled(false) };
        let _ = unsafe { settings.SetIsStatusBarEnabled(false) };
        diag.ok("web messaging enabled");

        Ok(Self {
            composition,
            controller,
            core,
            cursor: std::cell::Cell::new(windows::Win32::UI::WindowsAndMessaging::HCURSOR(
                std::ptr::null_mut(),
            )),
        })
    }

    /// Report whether the page actually loaded.
    ///
    /// THE DIAGNOSTIC THE FIRST RUN DID NOT HAVE. `NavigateToString` returning
    /// `Ok` means the navigation was QUEUED, exactly as `loadfile` does for
    /// mpv -- and Experiment 1a already cost a round to that distinction. A
    /// page that never loaded, a page that loaded but whose script never ran,
    /// and a page that rendered but is not visible all look identical from
    /// outside: an empty window. These make them three different log lines.
    ///
    /// Installed BEFORE `navigate`, so the first navigation cannot complete
    /// before anything is listening.
    pub fn on_load(&self, diag: &Diag, log: std::rc::Rc<Diag>) -> Result<(), String> {
        diag.step("add_NavigationCompleted + add_DOMContentLoaded");

        let navigated = std::rc::Rc::clone(&log);
        let mut token = 0i64;
        let handler = NavigationCompletedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                navigated.fail("NavigationCompleted fired with no args");
                return Ok(());
            };
            let mut ok = windows::core::BOOL(0);
            let _ = unsafe { args.IsSuccess(&mut ok) };
            if ok.as_bool() {
                navigated.ok("NavigationCompleted: the page LOADED");
            } else {
                let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                let _ = unsafe { args.WebErrorStatus(&mut status) };
                navigated.fail(&format!(
                    "NavigationCompleted: the page DID NOT LOAD. WebErrorStatus = {}. Nothing \
                     was rendered, so an empty window here is a navigation failure and NOT a \
                     compositing result.",
                    status.0
                ));
            }
            Ok(())
        }));
        unsafe { self.core.add_NavigationCompleted(&handler, &mut token) }
            .map_err(|e| format!("add_NavigationCompleted failed: {e}"))?;

        // DOMContentLoaded lives on ICoreWebView2_2. A runtime too old to offer
        // it is not a failure -- NavigationCompleted above is the load signal
        // that matters -- so this is reported and not propagated.
        match self.core.cast::<ICoreWebView2_2>() {
            Ok(core2) => {
                let dom = std::rc::Rc::clone(&log);
                let mut dom_token = 0i64;
                let dom_handler = DOMContentLoadedEventHandler::create(Box::new(move |_s, _a| {
                    dom.ok("DOMContentLoaded: the document was parsed");
                    Ok(())
                }));
                match unsafe { core2.add_DOMContentLoaded(&dom_handler, &mut dom_token) } {
                    Ok(()) => diag.ok("both load handlers installed"),
                    Err(e) => diag.fail(&format!("add_DOMContentLoaded failed: {e}")),
                }
            }
            Err(e) => diag.say(&format!(
                "  ..  ICoreWebView2_2 unavailable ({e}), so DOMContentLoaded is not observed. \
                 NavigationCompleted still is."
            )),
        }
        Ok(())
    }

    /// Navigate to the embedded page. Separate from `create` so the host can
    /// wire its message handler first and never miss the page's first message.
    pub fn navigate(&self, diag: &Diag) -> Result<(), String> {
        diag.step("NavigateToString(the embedded page)");
        unsafe { self.core.NavigateToString(&HSTRING::from(PAGE)) }
            .map_err(|e| format!("NavigateToString failed: {e}"))?;
        diag.ok(&format!("page queued, {} bytes", PAGE.len()));
        Ok(())
    }

    /// Install the one handler the page needs. `on_message` receives the raw
    /// string the page posted; the host maps it to an mpv command.
    pub fn on_web_message(
        &self,
        diag: &Diag,
        on_message: impl Fn(String) + 'static,
    ) -> Result<(), String> {
        diag.step("add_WebMessageReceived");
        let mut token = 0i64;
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_sender, args| {
            if let Some(args) = args {
                let mut message = windows::core::PWSTR::null();
                if unsafe { args.TryGetWebMessageAsString(&mut message) }.is_ok() {
                    let text = unsafe { message.to_string() }.unwrap_or_default();
                    on_message(text);
                }
            }
            Ok(())
        }));
        unsafe { self.core.add_WebMessageReceived(&handler, &mut token) }
            .map_err(|e| format!("add_WebMessageReceived failed: {e}"))?;
        diag.ok("the page can now reach the host");
        Ok(())
    }

    pub fn post(&self, json: &str) {
        let _ = unsafe { self.core.PostWebMessageAsJson(&HSTRING::from(json)) };
    }

    pub fn set_bounds(&self, width: i32, height: i32) {
        let _ = unsafe {
            self.controller.SetBounds(RECT {
                left: 0,
                top: 0,
                right: width,
                bottom: height,
            })
        };
    }

    pub fn set_scale(&self, scale: f32) {
        if let Ok(controller3) = self.controller.cast::<ICoreWebView2Controller3>() {
            let _ = unsafe { controller3.SetRasterizationScale(scale as f64) };
        }
    }

    /// Forward one mouse message. `kind` and `data` come from the host's
    /// message switch; `point` is already in client coordinates.
    pub fn send_mouse(&self, kind: COREWEBVIEW2_MOUSE_EVENT_KIND, data: u32, point: POINT) {
        let _ = unsafe {
            self.composition.SendMouseInput(
                kind,
                COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE,
                data,
                point,
            )
        };
    }

    /// Hand real Win32 focus to WebView2's hidden input HWND. This, not
    /// per-message keyboard forwarding, is how a composition-hosted webview
    /// gets keystrokes -- and it is also what makes a click land as a click
    /// rather than as a stray move.
    pub fn move_focus(&self) {
        let _ = unsafe {
            self.controller
                .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
        };
    }

    pub fn parent_moved(&self) {
        let _ = unsafe { self.controller.NotifyParentWindowPositionChanged() };
    }

    /// Criterion 8. `Close` tears the webview down deterministically instead
    /// of leaving it to COM release order at process exit, which is where an
    /// orphaned `msedgewebview2.exe` comes from.
    pub fn close(&self, diag: &Diag) {
        diag.step("ICoreWebView2Controller::Close");
        match unsafe { self.controller.Close() } {
            Ok(()) => diag.ok("the webview controller is closed"),
            Err(e) => diag.fail(&format!(
                "Close failed: {e}. Check Task Manager for a surviving msedgewebview2.exe -- that \
                 is criterion 8."
            )),
        }
    }
}
