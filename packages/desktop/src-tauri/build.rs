fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "server_connect",
            "server_write",
            "server_ack",
            "server_stop",
        ]),
    ))
    .expect("Could not generate desktop permissions")
}
