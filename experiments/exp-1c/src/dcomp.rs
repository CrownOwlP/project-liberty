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
         * Z-ORDER, AND IT IS THE ONE THING THIS EXPERIMENT MUST GET RIGHT.
         * `AddVisual(visual, insertAbove, referenceVisual)` with a NULL
         * reference inserts at the bottom when `insertAbove` is false and at
         * the top when it is true. So: video at the bottom, web above it.
         * Getting these two the wrong way round would hide the video and
         * produce a result indistinguishable from Experiment 1a's failure,
         * which is why it is spelled out rather than left to argument order.
         */
        diag.step("attach video BELOW and web ABOVE in the root visual");
        unsafe { root.AddVisual(&video, false, None) }
            .map_err(|e| format!("AddVisual(video, bottom) failed: {e}"))?;
        unsafe { root.AddVisual(&web, true, None) }
            .map_err(|e| format!("AddVisual(web, top) failed: {e}"))?;
        diag.ok("video is the bottom child, web is the top child");

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
}
