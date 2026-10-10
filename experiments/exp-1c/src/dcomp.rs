//! The DirectComposition visual tree, which is the whole experiment.
//!
//! ```text
//! Top-level HWND (ours; paints nothing itself)
//! └── IDCompositionTarget
//!     └── root visual
//!         ├── video visual  ──►  SetContent(mpv's composition IDXGISwapChain)
//!         └── web visual    ──►  SetRootVisualTarget on the WebView2
//!                                composition controller            (above)
//! ```
//!
//! WHY THIS CAN WORK WHERE EXPERIMENT 1a COULD NOT. In 1a the two layers were
//! two WINDOWS -- a child HWND and the WebView2 controller's own HWND -- and
//! window z-order decided which one the user saw. Here neither layer owns a
//! window. Both are content inside one visual tree, DWM composites the tree,
//! and "above" is a property of the tree rather than of a window hierarchy.
//! That is also why `put_DefaultBackgroundColor(0,0,0,0)` has a chance of
//! meaning something this time: there is a visual beneath to show through to,
//! rather than another window.
//!
//! THIS IS NOT A CLAIM THAT IT DOES WORK. Nothing here has run. The arrangement
//! is the hypothesis; the commander's eyes are the test.

use crate::diag::Diag;
use windows::core::Interface;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice, IDCompositionDevice, IDCompositionTarget, IDCompositionVisual,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;

pub struct Tree {
    pub device: IDCompositionDevice,
    /// Held so the target outlives the tree. Dropping it detaches the whole
    /// composition from the window.
    pub _target: IDCompositionTarget,
    /// Held so the tree outlives the struct; nothing reads it after setup.
    /// Dropping it would unparent both children.
    pub _root: IDCompositionVisual,
    pub video: IDCompositionVisual,
    pub web: IDCompositionVisual,
}

impl Tree {
    /// Build the tree. Every step is logged by name, because a tree that fails
    /// to build looks exactly like a tree that built and showed nothing.
    pub fn create(hwnd: HWND, diag: &Diag) -> Result<Self, String> {
        /*
         * A D3D11 DEVICE OF OUR OWN, PURELY TO BACK THE DComp DEVICE.
         * `DCompositionCreateDevice` documents its DXGI device as optional,
         * but an explicitly created one removes a question from a run whose
         * whole value is that its failures are unambiguous. mpv keeps its own
         * device; DirectComposition does not require them to be the same, and
         * mpv's composition swapchain is attached as CONTENT rather than
         * rendered by this device.
         */
        diag.step("D3D11CreateDevice (BGRA, hardware) to back the DComp device");
        let mut d3d = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                // `software` is an HMODULE, not an optional adapter: it names
                // a software rasteriser DLL and is only meaningful with
                // D3D_DRIVER_TYPE_SOFTWARE. Default is the documented "none".
                windows::Win32::Foundation::HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut d3d),
                None,
                None,
            )
        }
        .map_err(|e| format!("D3D11CreateDevice failed: {e}"))?;
        let d3d = d3d.ok_or_else(|| "D3D11CreateDevice returned no device".to_string())?;
        diag.ok("D3D11 device created");

        diag.step("query it for IDXGIDevice");
        let dxgi: IDXGIDevice = d3d
            .cast()
            .map_err(|e| format!("the D3D11 device is not an IDXGIDevice: {e}"))?;
        diag.ok("IDXGIDevice obtained");

        diag.step("DCompositionCreateDevice");
        let device: IDCompositionDevice =
            unsafe { DCompositionCreateDevice(&dxgi) }.map_err(|e| {
                format!(
                "DCompositionCreateDevice failed: {e}. DirectComposition is unavailable on this \
                 machine, so the experiment CANNOT be judged on this run."
            )
            })?;
        diag.ok("IDCompositionDevice created");

        diag.step("CreateTargetForHwnd(topmost = true)");
        let target = unsafe { device.CreateTargetForHwnd(hwnd, true) }
            .map_err(|e| format!("CreateTargetForHwnd failed: {e}"))?;
        diag.ok("IDCompositionTarget bound to the host window");

        diag.step("CreateVisual x3 (root, video, web)");
        let root = unsafe { device.CreateVisual() }
            .map_err(|e| format!("CreateVisual(root) failed: {e}"))?;
        let video = unsafe { device.CreateVisual() }
            .map_err(|e| format!("CreateVisual(video) failed: {e}"))?;
        let web = unsafe { device.CreateVisual() }
            .map_err(|e| format!("CreateVisual(web) failed: {e}"))?;
        diag.ok("three visuals created");

        /*
         * Z-ORDER, AND THE FIRST VERSION OF THIS FILE GOT IT EXACTLY
         * BACKWARDS -- which is why the commander's first run showed video
         * playing and no HTML at all.
         *
         * MICROSOFT'S OWN REMARKS ON `IDCompositionVisual::AddVisual`, and
         * they are worth quoting because they are the opposite of what the
         * parameter name suggests:
         *
         *   "If the referenceVisual parameter is NULL, the specified visual is
         *    rendered above or below all children of the parent visual,
         *    depending on the value of the insertAbove parameter. If
         *    insertAbove is TRUE, the new child visual is above no sibling,
         *    therefore it is rendered BELOW all of its siblings. Conversely,
         *    if insertAbove is FALSE, the visual is below no sibling,
         *    therefore it is rendered ABOVE all of its siblings."
         *
         * So with a NULL reference the flag is INVERTED relative to its own
         * name. The previous code called `AddVisual(video, false, None)` and
         * `AddVisual(web, true, None)`, which put the OPAQUE VIDEO SWAPCHAIN
         * ON TOP and the webview underneath it. The old comment here asserted
         * the opposite and was written without checking the documentation --
         * in a comment that called this "the one thing this experiment must
         * get right".
         *
         * TWO CHANGES, SO THIS CANNOT GO WRONG THE SAME WAY AGAIN. The video
         * is added with `insertAbove = true` and a NULL reference, which under
         * the quoted semantics means "below all siblings". The web visual is
         * added with an EXPLICIT reference visual, where the parameter means
         * exactly what its name says -- "TRUE to place the new child visual in
         * front of the visual specified by the referenceVisual parameter" --
         * and there is no counterintuitive NULL case to misread.
         */
        diag.step("attach video BELOW and web IN FRONT OF it in the root visual");
        unsafe { root.AddVisual(&video, true, None) }
            .map_err(|e| format!("AddVisual(video, below all siblings) failed: {e}"))?;
        unsafe { root.AddVisual(&web, true, Some(&video)) }
            .map_err(|e| format!("AddVisual(web, in front of video) failed: {e}"))?;
        diag.ok(
            "video was added with insertAbove=true and a NULL reference, which Microsoft \
             documents as 'rendered below all of its siblings'; web was added with \
             insertAbove=true and video as the REFERENCE visual, which means 'in front of \
             video'. The webview is the top layer.",
        );

        diag.step("SetRoot + Commit");
        unsafe { target.SetRoot(&root) }.map_err(|e| format!("SetRoot failed: {e}"))?;
        unsafe { device.Commit() }.map_err(|e| format!("Commit failed: {e}"))?;
        diag.ok("the visual tree is committed and attached to the window");

        Ok(Self {
            device,
            _target: target,
            _root: root,
            video,
            web,
        })
    }

    /// Attach mpv's composition swapchain as the video visual's content.
    ///
    /// The pointer comes from mpv's `display-swapchain` property as an
    /// `int64`. It is borrowed, NOT adopted: mpv owns that swapchain and
    /// releases it in `d3d11_uninit`, so taking ownership here would
    /// double-release it on shutdown. `IUnknown::from_raw_borrowed` is exactly
    /// that distinction expressed in the type system.
    pub fn attach_video(
        &self,
        swapchain: *mut std::ffi::c_void,
        diag: &Diag,
    ) -> Result<(), String> {
        diag.step(&format!(
            "IDCompositionVisual::SetContent(mpv swapchain 0x{:x})",
            swapchain as usize
        ));
        let content = unsafe { windows::core::IUnknown::from_raw_borrowed(&swapchain) }
            .ok_or_else(|| "mpv handed back a null swapchain pointer".to_string())?;
        unsafe { self.video.SetContent(content) }.map_err(|e| {
            format!(
                "SetContent failed: {e}. mpv produced a swapchain but DirectComposition would not \
                 take it as content -- if this is DXGI_ERROR_INVALID_CALL it means the swapchain \
                 was not created for composition, which would contradict \
                 --d3d11-output-mode=composition."
            )
        })?;
        unsafe { self.device.Commit() }
            .map_err(|e| format!("Commit after SetContent failed: {e}"))?;
        diag.ok("mpv's swapchain is now the content of the BOTTOM visual");
        Ok(())
    }

    pub fn commit(&self) -> Result<(), String> {
        unsafe { self.device.Commit() }.map_err(|e| format!("Commit failed: {e}"))
    }

    /// Commit, and say so in the log.
    ///
    /// Microsoft's `RootVisualTarget` reference is explicit that this is
    /// required and the harness was not doing it: *"The app needs to commit on
    /// its device setting the RootVisualTarget property."* Before this, the
    /// next `Commit` happened only when mpv's swapchain arrived — about a
    /// second later, and not at all if it never arrived, which would have left
    /// the webview unattached for a reason no log line named.
    pub fn commit_named(&self, what: &str, diag: &Diag) {
        match self.commit() {
            Ok(()) => diag.ok(&format!("IDCompositionDevice::Commit after {what}")),
            Err(error) => diag.fail(&format!(
                "Commit after {what} FAILED: {error}. Anything set since the last successful \
                 commit is not on screen."
            )),
        }
    }
}
