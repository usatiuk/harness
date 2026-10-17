use base64::{Engine, engine::general_purpose::STANDARD};
use std::{fs::File, io::Read, path::PathBuf};

const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMAGE_CONTENT_BYTES: usize = 3 * 1024 * 1024;

fn encode_images(images: impl IntoIterator<Item = Vec<u8>>) -> Result<Vec<String>, String> {
    let mut total = 0;
    let mut encoded_bytes = 2;
    let mut encoded = Vec::new();
    for bytes in images {
        total += bytes.len();
        if total > MAX_IMAGE_BYTES {
            return Err("Images must fit within 2 MiB per message.".into());
        }
        let data = STANDARD.encode(bytes);
        encoded_bytes += data.len() + 3;
        if encoded_bytes > MAX_IMAGE_CONTENT_BYTES {
            return Err("Images exceed the encoded image limit.".into());
        }
        encoded.push(data);
    }
    Ok(encoded)
}

fn read_paths(paths: Vec<PathBuf>) -> Result<Vec<String>, String> {
    let mut total = 0;
    let mut images = Vec::new();
    for path in paths {
        let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err("Only image files can be attached.".into());
        }
        if metadata.len() > (MAX_IMAGE_BYTES - total) as u64 {
            return Err("Images must fit within 2 MiB per message.".into());
        }
        let mut bytes = Vec::new();
        File::open(&path)
            .map_err(|error| error.to_string())?
            .take((MAX_IMAGE_BYTES - total + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        total += bytes.len();
        if total > MAX_IMAGE_BYTES {
            return Err("Images must fit within 2 MiB per message.".into());
        }
        images.push(bytes);
    }
    encode_images(images)
}

fn file_uri_path(uri: &str) -> Result<PathBuf, String> {
    tauri::Url::parse(uri)
        .map_err(|_| "Clipboard contains an invalid file URI.".to_string())?
        .to_file_path()
        .map_err(|_| "Only local clipboard files can be attached.".to_string())
}

#[tauri::command]
pub async fn read_image_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_paths(paths.into_iter().map(PathBuf::from).collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

enum ClipboardImages {
    Paths(Vec<PathBuf>),
    Image(Vec<u8>),
}

#[cfg(target_os = "linux")]
async fn read_clipboard(app: tauri::AppHandle) -> Result<Option<ClipboardImages>, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || request_clipboard(send))
        .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}

#[cfg(target_os = "linux")]
fn request_clipboard(send: tokio::sync::oneshot::Sender<Result<Option<ClipboardImages>, String>>) {
    use gtk::gdk;
    let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
    clipboard.request_uris(move |clipboard, uris| {
        if !uris.is_empty() {
            let paths: Result<Vec<_>, _> = uris.iter().map(|uri| file_uri_path(uri)).collect();
            // A canceled IPC request may no longer have a receiver.
            let _ = send.send(paths.map(|paths| Some(ClipboardImages::Paths(paths))));
        } else {
            clipboard.request_contents(&gdk::Atom::intern("TARGETS"), move |clipboard, data| {
                let targets = data.targets().unwrap_or_default();
                let target = ["image/png", "image/jpeg", "image/webp", "image/gif"]
                    .into_iter()
                    .map(gdk::Atom::intern)
                    .find(|target| targets.contains(target));
                let Some(target) = target else {
                    let result = if targets
                        .iter()
                        .any(|target| target.name().starts_with("image/"))
                    {
                        Err("Unsupported clipboard image. Use PNG, JPEG, WebP, or GIF.".into())
                    } else {
                        Ok(None)
                    };
                    let _ = send.send(result);
                    return;
                };
                clipboard.request_contents(&target, move |_, data| {
                    let result = if data.length() <= 0 {
                        Err("Clipboard image could not be read.".into())
                    } else if data.length() as usize > MAX_IMAGE_BYTES {
                        Err("Images must fit within 2 MiB per message.".into())
                    } else {
                        Ok(Some(ClipboardImages::Image(data.data())))
                    };
                    let _ = send.send(result);
                });
            });
        }
    });
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
async fn read_clipboard(_app: tauri::AppHandle) -> Result<Option<ClipboardImages>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        use clipboard_rs::{Clipboard, ClipboardContext, ContentFormat, common::RustImage};
        let clipboard = ClipboardContext::new().map_err(|error| error.to_string())?;
        if clipboard.has(ContentFormat::Files) {
            let paths = clipboard
                .get_files()
                .map_err(|error| error.to_string())?
                .into_iter()
                .map(|path| {
                    if path.starts_with("file:") {
                        file_uri_path(&path)
                    } else {
                        Ok(PathBuf::from(path))
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Some(ClipboardImages::Paths(paths)))
        } else if clipboard.has(ContentFormat::Image) {
            let image = clipboard.get_image().map_err(|error| error.to_string())?;
            let png = image.to_png().map_err(|error| error.to_string())?;
            Ok(Some(ClipboardImages::Image(png.get_bytes().to_vec())))
        } else {
            Ok(None)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn clipboard_image_data(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    match read_clipboard(app).await? {
        None => Ok(Vec::new()),
        Some(ClipboardImages::Image(bytes)) => encode_images([bytes]),
        Some(ClipboardImages::Paths(paths)) => {
            tauri::async_runtime::spawn_blocking(move || read_paths(paths))
                .await
                .map_err(|error| error.to_string())?
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_exact_bytes_and_enforces_aggregate_file_budget() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first.png");
        let second = directory.path().join("second.png");
        std::fs::write(&first, [137, 80, 78, 71]).unwrap();
        std::fs::write(&second, [1, 2, 3]).unwrap();
        let result = read_paths(vec![first.clone(), second.clone()]).unwrap();
        assert_eq!(STANDARD.decode(&result[0]).unwrap(), [137, 80, 78, 71]);
        assert_eq!(STANDARD.decode(&result[1]).unwrap(), [1, 2, 3]);
        File::create(&second)
            .unwrap()
            .set_len(MAX_IMAGE_BYTES as u64)
            .unwrap();
        assert!(
            read_paths(vec![first, second])
                .unwrap_err()
                .contains("2 MiB")
        );
    }

    #[test]
    fn rejects_oversize_files_and_directories() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.png");
        let mut file = File::create(&path).unwrap();
        file.write_all(&[137, 80, 78, 71]).unwrap();
        file.set_len(MAX_IMAGE_BYTES as u64 + 1).unwrap();
        assert!(read_paths(vec![path]).unwrap_err().contains("2 MiB"));
        assert!(read_paths(vec![directory.path().to_path_buf()]).is_err());
    }

    #[test]
    fn decodes_local_file_uris_and_rejects_remote_uris() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("a space.png");
        let uri = tauri::Url::from_file_path(&path).unwrap();
        assert_eq!(file_uri_path(uri.as_str()).unwrap(), path);
        assert!(file_uri_path("https://example.com/image.png").is_err());
        #[cfg(not(target_os = "windows"))]
        assert!(file_uri_path("file://remote-host/image.png").is_err());
    }
    #[test]
    #[cfg(target_os = "linux")]
    #[ignore = "requires an isolated GTK display"]
    fn reads_native_clipboard_file_uris_and_png_without_dom_files() {
        use gtk::{gdk, gdk_pixbuf, glib};
        gtk::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("clipboard image.png");
        std::fs::write(&path, b"test").unwrap();
        let uri = tauri::Url::from_file_path(&path).unwrap().to_string();
        let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
        let targets = [gtk::TargetEntry::new(
            "text/uri-list",
            gtk::TargetFlags::empty(),
            0,
        )];
        assert!(clipboard.set_with_data(&targets, move |_, selection, _| {
            assert!(selection.set_uris(&[uri.as_str()]));
        }));
        let (send, receive) = tokio::sync::oneshot::channel();
        request_clipboard(send);
        let result = glib::MainContext::default()
            .block_on(receive)
            .unwrap()
            .unwrap()
            .unwrap();
        match result {
            ClipboardImages::Paths(paths) => assert_eq!(paths, vec![path]),
            ClipboardImages::Image(_) => panic!("file URI was returned as a bitmap"),
        }
        let image = gdk_pixbuf::Pixbuf::new(gdk_pixbuf::Colorspace::Rgb, true, 8, 1, 1).unwrap();
        image.fill(0xff4400ff);
        clipboard.set_image(&image);
        let (send, receive) = tokio::sync::oneshot::channel();
        request_clipboard(send);
        let result = glib::MainContext::default()
            .block_on(receive)
            .unwrap()
            .unwrap()
            .unwrap();
        match result {
            ClipboardImages::Image(bytes) => assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n")),
            ClipboardImages::Paths(_) => panic!("bitmap was returned as file URIs"),
        }
        let jpeg_image =
            gdk_pixbuf::Pixbuf::new(gdk_pixbuf::Colorspace::Rgb, false, 8, 1, 1).unwrap();
        jpeg_image.fill(0xff4400ff);
        let jpeg = jpeg_image.save_to_bufferv("jpeg", &[]).unwrap();
        let expected = jpeg.clone();
        let targets = [gtk::TargetEntry::new(
            "image/jpeg",
            gtk::TargetFlags::empty(),
            0,
        )];
        assert!(clipboard.set_with_data(&targets, move |_, selection, _| {
            selection.set(&gdk::Atom::intern("image/jpeg"), 8, &jpeg);
        }));
        let (send, receive) = tokio::sync::oneshot::channel();
        request_clipboard(send);
        let result = glib::MainContext::default()
            .block_on(receive)
            .unwrap()
            .unwrap()
            .unwrap();
        match result {
            ClipboardImages::Image(bytes) => assert_eq!(bytes, expected),
            ClipboardImages::Paths(_) => panic!("JPEG was returned as file URIs"),
        }
        let targets = [gtk::TargetEntry::new(
            "image/tiff",
            gtk::TargetFlags::empty(),
            0,
        )];
        assert!(clipboard.set_with_data(&targets, move |_, selection, _| {
            selection.set(&gdk::Atom::intern("image/tiff"), 8, b"unsupported");
        }));
        let (send, receive) = tokio::sync::oneshot::channel();
        request_clipboard(send);
        let result = glib::MainContext::default().block_on(receive).unwrap();
        assert!(matches!(result, Err(error) if error.contains("Unsupported clipboard image")));
    }
}
