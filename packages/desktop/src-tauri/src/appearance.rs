use tauri::{Manager, State};
#[cfg(any(windows, target_os = "macos"))]
use tauri_plugin_decoration::WebviewWindowExt;

pub struct NativeMaterial(pub bool);

// Tauri 2.12.1's effects wrapper discards installation errors. The direct call
// keeps unsupported systems opaque without guessing the OS version.
pub fn install(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("main")
        .expect("Desktop main window is missing");

    #[cfg(target_os = "linux")]
    harness_desktop::rendering::install(&window)?;

    #[cfg(windows)]
    let result = window_vibrancy::apply_mica(&window, None);
    #[cfg(target_os = "macos")]
    let result = window_vibrancy::apply_vibrancy(
        &window,
        window_vibrancy::NSVisualEffectMaterial::Sidebar,
        None,
        None,
    );
    #[cfg(not(any(windows, target_os = "macos")))]
    let result = {
        let _ = window;
        Err(window_vibrancy::Error::UnsupportedPlatform(
            "Native window materials are unavailable on this platform",
        ))
    };

    // Only an unsupported OS selects solid CSS. Never expose a transparent
    // sidebar after a failed material installation.
    let material = match result {
        Ok(()) => true,
        Err(window_vibrancy::Error::UnsupportedPlatform(_))
        | Err(window_vibrancy::Error::UnsupportedPlatformVersion(_)) => false,
        Err(error) => return Err(error.into()),
    };
    app.manage(NativeMaterial(material));
    Ok(())
}

#[tauri::command]
pub fn window_material(material: State<'_, NativeMaterial>) -> bool {
    material.inner().0
}

#[tauri::command]
pub async fn window_decorate(window: tauri::WebviewWindow) -> Result<&'static str, String> {
    #[cfg(any(windows, target_os = "macos"))]
    window
        .activate_decoration()
        .await
        .map_err(|error| error.to_string())?;
    #[cfg(windows)]
    return Ok("windows");
    #[cfg(target_os = "macos")]
    return Ok("macos");
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = window;
        Ok("native")
    }
}

#[tauri::command]
pub async fn window_modal(window: tauri::WebviewWindow, opacity: f64) -> Result<(), String> {
    if !(0.0..=1.0).contains(&opacity) {
        return Err("Invalid window-control opacity".into());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowButton};
        let (send, receive) = tokio::sync::oneshot::channel();
        let native_window = window.clone();
        window
            .run_on_main_thread(move || {
                let result = (|| {
                    let pointer = native_window
                        .ns_window()
                        .map_err(|error| error.to_string())?;
                    let native = unsafe { &*(pointer as *const NSWindow) };
                    for kind in [
                        NSWindowButton::CloseButton,
                        NSWindowButton::MiniaturizeButton,
                        NSWindowButton::ZoomButton,
                    ] {
                        let button = native
                            .standardWindowButton(kind)
                            .ok_or("Missing native window control")?;
                        button.setAlphaValue(opacity);
                    }
                    Ok::<(), String>(())
                })();
                // A destroyed invoking document may cancel its response.
                let _ = send.send(result);
            })
            .map_err(|error| error.to_string())?;
        return receive.await.map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(())
    }
}
