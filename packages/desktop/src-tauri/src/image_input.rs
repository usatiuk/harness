use base64::{Engine, engine::general_purpose::STANDARD};
use std::{fs::File, io::Read, path::PathBuf};

const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMAGE_CONTENT_BYTES: usize = 3 * 1024 * 1024;

fn read_paths(paths: Vec<PathBuf>) -> Result<Vec<String>, String> {
    let mut total = 0;
    let mut encoded_bytes = 2;
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
        let data = STANDARD.encode(bytes);
        encoded_bytes += data.len() + 3;
        if encoded_bytes > MAX_IMAGE_CONTENT_BYTES {
            return Err("Images exceed the encoded image limit.".into());
        }
        images.push(data);
    }
    Ok(images)
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
        let paths = paths
            .into_iter()
            .map(|path| {
                if path.starts_with("file:") {
                    file_uri_path(&path)
                } else {
                    Ok(PathBuf::from(path))
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        read_paths(paths)
    })
    .await
    .map_err(|error| error.to_string())?
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
}
