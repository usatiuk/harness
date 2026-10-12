use std::ffi::{CStr, c_char, c_int, c_void};
use webkit2gtk::{Settings, WebViewExt, glib::translate::ToGlibPtr};

// webkit2gtk 2.0 binds through 2.40; this public feature API requires WebKitGTK 2.42.
#[link(name = "webkit2gtk-4.1")]
unsafe extern "C" {
    fn webkit_settings_get_all_features() -> *mut c_void;
    fn webkit_feature_list_get_length(list: *mut c_void) -> usize;
    fn webkit_feature_list_get(list: *mut c_void, index: usize) -> *mut c_void;
    fn webkit_feature_get_identifier(feature: *mut c_void) -> *const c_char;
    fn webkit_feature_list_unref(list: *mut c_void);
    fn webkit_settings_set_feature_enabled(
        settings: *mut webkit2gtk::ffi::WebKitSettings,
        feature: *mut c_void,
        enabled: c_int,
    );
    fn webkit_settings_get_feature_enabled(
        settings: *mut webkit2gtk::ffi::WebKitSettings,
        feature: *mut c_void,
    ) -> c_int;
}

struct Features(*mut c_void);
impl Drop for Features {
    fn drop(&mut self) {
        unsafe { webkit_feature_list_unref(self.0) };
    }
}

fn use_display_refresh(settings: &Settings) -> Result<(), &'static str> {
    // The list owns its borrowed features; keep it alive through both settings calls.
    unsafe {
        let list = webkit_settings_get_all_features();
        assert!(!list.is_null(), "WebKit returned no feature list");
        let features = Features(list);
        for index in 0..webkit_feature_list_get_length(features.0) {
            let feature = webkit_feature_list_get(features.0, index);
            assert!(
                !feature.is_null(),
                "WebKit returned no feature at a valid index"
            );
            let identifier = webkit_feature_get_identifier(feature);
            assert!(!identifier.is_null(), "WebKit feature has no identifier");
            if CStr::from_ptr(identifier).to_bytes() == b"PreferPageRenderingUpdatesNear60FPS" {
                let pointer = settings.to_glib_none().0;
                webkit_settings_set_feature_enabled(pointer, feature, 0);
                return if webkit_settings_get_feature_enabled(pointer, feature) == 0 {
                    Ok(())
                } else {
                    Err("WebKit did not disable the near-60-FPS preference")
                };
            }
        }
    }
    Err("WebKit lacks PreferPageRenderingUpdatesNear60FPS")
}

pub fn install(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|native| {
        let settings = native
            .inner()
            .settings()
            .expect("WebKit settings are missing");
        use_display_refresh(&settings).expect("Could not configure WebKit display refresh");
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn disables_the_native_near_60_fps_preference() {
        // Settings is a GObject; exercising its C API needs no display or WebView.
        let settings = unsafe {
            webkit2gtk::glib::translate::from_glib_full(webkit2gtk::ffi::webkit_settings_new())
        };
        super::use_display_refresh(&settings).unwrap();
    }
}
