#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{Manager, ipc::Channel};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{Mutex, Notify, oneshot, watch},
};

const MAX_FRAME: usize = 4 * 1024 * 1024;

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerEvent {
    Message { id: u64, frame: String },
    Closed { message: String },
}

struct Server {
    id: u64,
    credit: Arc<Notify>,
    cancel: watch::Sender<bool>,
    input: Arc<Mutex<Option<ChildStdin>>>,
    stop: Option<oneshot::Sender<()>>,
    finished: Arc<AtomicBool>,
    done: oneshot::Receiver<Result<(), String>>,
}

#[derive(Default)]
struct Bridge {
    server: Mutex<Option<Server>>,
    next_id: AtomicU64,
}

impl Bridge {
    async fn close(&self) -> Result<(), String> {
        let mut slot = self.server.lock().await;
        let Some(server) = slot.as_mut() else {
            return Ok(());
        };
        // Closing stdin asks the existing stdio server to cancel and drain all
        // roots. Keep the native application alive until the child exits.
        let already_exited = server.finished.load(Ordering::Acquire);
        let _ = server.cancel.send(true);
        if let Some(stop) = server.stop.take() {
            let _ = stop.send(());
        }
        let result = (&mut server.done)
            .await
            .map_err(|_| "Server owner task failed".to_string());
        // Hold the ownership slot through drainage so connect cannot race stop.
        slot.take();
        let result = result?;
        // Its terminal failure was already delivered to the UI. Recovery can
        // start a fresh child once this previous process has finished draining.
        if already_exited { Ok(()) } else { result }
    }
}

async fn read_frames(
    output: tokio::process::ChildStdout,
    channel: &Channel<ServerEvent>,
    id: u64,
    credit: Arc<Notify>,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    let mut reader = BufReader::new(output);
    loop {
        let mut bytes = Vec::new();
        let count = (&mut reader)
            .take((MAX_FRAME + 2) as u64)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|_| "Could not read the Harness server".to_string())?;
        if count == 0 {
            return Ok(());
        }
        if count > MAX_FRAME + 1 || bytes.last() != Some(&b'\n') {
            return Err("Harness server sent an oversized or incomplete frame".into());
        }
        bytes.pop();
        let frame = String::from_utf8(bytes)
            .map_err(|_| "Harness server sent invalid UTF-8".to_string())?;
        channel
            .send(ServerEvent::Message { id, frame })
            .map_err(|_| "Desktop protocol receiver disconnected".to_string())?;
        // One frame in flight bounds Tauri's otherwise unbounded channel queue.
        // Closing also releases this wait when the WebView is no longer alive.
        tokio::select! {
            _ = credit.notified() => {},
            _ = cancel.changed() => return Ok(()),
        }
    }
}

async fn read_diagnostics(error: tokio::process::ChildStderr) -> Result<String, String> {
    let mut reader = BufReader::new(error);
    let mut tail = Vec::new();
    let mut chunk = [0; 1024];
    loop {
        let count = reader
            .read(&mut chunk)
            .await
            .map_err(|_| "Could not read server diagnostics".to_string())?;
        if count == 0 {
            return Ok(String::from_utf8_lossy(&tail).into_owned());
        }
        tail.extend_from_slice(&chunk[..count]);
        if tail.len() > 8192 {
            tail.drain(..tail.len() - 8192);
        }
    }
}

#[tauri::command]
async fn server_connect(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Arc<Bridge>>,
    channel: Channel<ServerEvent>,
) -> Result<u64, String> {
    let mut slot = bridge.server.lock().await;
    if slot.is_some() {
        return Err("The desktop server is already connected".into());
    }
    let resources = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources")
    } else {
        app.path()
            .resource_dir()
            .map_err(|error| error.to_string())?
            .join("server")
    };
    // Tauri's Windows resource directory can be a verbatim path. Node's script
    // entry-point resolution requires the ordinary form when it is equivalent.
    #[cfg(windows)]
    let resources = dunce::simplified(&resources).to_path_buf();
    let node = resources
        .join("runtime")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let mut command = Command::new(node);
    command
        .arg(resources.join("server.mjs"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the bundled Harness server: {error}"))?;
    let input = Arc::new(Mutex::new(Some(
        child.stdin.take().expect("spawned piped stdin"),
    )));
    let output = child.stdout.take().expect("spawned piped stdout");
    let error = child.stderr.take().expect("spawned piped stderr");
    let (stop, stopped) = oneshot::channel();
    let (complete, done) = oneshot::channel();
    let owner_input = input.clone();
    let id = bridge.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let credit = Arc::new(Notify::new());
    let (cancel, canceled) = watch::channel(false);
    let owner_cancel = cancel.clone();
    let finished = Arc::new(AtomicBool::new(false));
    let owner_finished = finished.clone();
    let reader_credit = credit.clone();
    tauri::async_runtime::spawn(async move {
        let diagnostics = tauri::async_runtime::spawn(read_diagnostics(error));
        let stream_channel = channel.clone();
        let mut stream = tauri::async_runtime::spawn(async move {
            read_frames(output, &stream_channel, id, reader_credit, canceled).await
        });
        let mut stream_result = None;
        let immediate = tokio::select! {
            status = child.wait() => Some(status.map_err(|error| error.to_string())),
            result = &mut stream => {
                stream_result = Some(result);
                None
            },
            _ = stopped => None,
        };
        // Release writes and frame credit before waiting for either pipe owner.
        let _ = owner_cancel.send(true);
        owner_input.lock().await.take();
        let status = match immediate {
            Some(status) => status,
            None => match tokio::time::timeout(Duration::from_secs(20), child.wait()).await {
                Ok(status) => status.map_err(|error| error.to_string()),
                Err(_) => {
                    let killed = child.kill().await;
                    Err(format!(
                        "Harness server did not finish shutdown within 20 seconds (termination: {killed:?})"
                    ))
                }
            },
        };
        let stream_result = match stream_result {
            Some(result) => result,
            None => stream.await,
        };
        let diagnostics = diagnostics.await;
        let result = match (status, stream_result, diagnostics) {
            (Ok(status), Ok(Ok(())), Ok(Ok(_))) if status.success() => Ok(()),
            (Ok(status), _, Ok(Ok(diagnostics))) if !status.success() => Err(
                if diagnostics.contains("already in use by another server") {
                    "Harness is already running with this database. Close the other GUI or TUI and retry.".into()
                } else {
                    format!("Harness server exited with {status}. {diagnostics}")
                },
            ),
            (Err(error), _, _) => Err(error),
            (_, Ok(Err(error)), _) => Err(error),
            (_, Err(error), _) => Err(format!("Protocol reader failed: {error}")),
            (_, _, _) => Err("Server diagnostic reader failed".into()),
        };
        let message = match &result {
            Ok(()) => "Harness server disconnected".into(),
            Err(error) => error.clone(),
        };
        owner_finished.store(true, Ordering::Release);
        let _ = channel.send(ServerEvent::Closed { message });
        let _ = complete.send(result);
    });
    *slot = Some(Server {
        id,
        credit,
        cancel,
        input,
        stop: Some(stop),
        done,
        finished,
    });
    Ok(id)
}

#[tauri::command]
async fn server_write(
    bridge: tauri::State<'_, Arc<Bridge>>,
    id: u64,
    frame: String,
) -> Result<(), String> {
    if frame.len() > MAX_FRAME || frame.contains('\n') {
        return Err("Invalid desktop protocol frame".into());
    }
    let (input, mut cancel) = {
        let slot = bridge.server.lock().await;
        let server = slot.as_ref().ok_or("Harness server is disconnected")?;
        if server.id != id {
            return Err("Desktop connection is obsolete".into());
        }
        (server.input.clone(), server.cancel.subscribe())
    };
    if *cancel.borrow() {
        return Err("Harness server is disconnected".into());
    }
    let mut input = input.lock().await;
    let writer = input.as_mut().ok_or("Harness server is disconnected")?;
    tokio::select! {
        _ = cancel.changed() => Err("Harness server is disconnected".into()),
        result = async {
            writer.write_all(frame.as_bytes()).await.map_err(|_| "Server write failed".to_string())?;
            writer.write_all(b"\n").await.map_err(|_| "Server write failed".to_string())
        } => result,
    }
}

#[tauri::command]
async fn server_ack(bridge: tauri::State<'_, Arc<Bridge>>, id: u64) -> Result<(), String> {
    let slot = bridge.server.lock().await;
    let server = slot.as_ref().ok_or("Harness server is disconnected")?;
    if server.id != id {
        return Err("Desktop connection is obsolete".into());
    }
    server.credit.notify_one();
    Ok(())
}

#[tauri::command]
async fn server_stop(bridge: tauri::State<'_, Arc<Bridge>>) -> Result<(), String> {
    bridge.close().await
}

fn main() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(Bridge::default()))
        .invoke_handler(tauri::generate_handler![
            server_connect,
            server_write,
            server_ack,
            server_stop
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not build the Harness desktop application");
    let shutdown_failed = Arc::new(AtomicBool::new(false));
    let failure = shutdown_failed.clone();
    let code = application.run_return(move |app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let bridge = app.state::<Arc<Bridge>>();
            if let Err(error) = tauri::async_runtime::block_on(bridge.close()) {
                eprintln!("Desktop shutdown failed: {error}");
                failure.store(true, Ordering::Release);
            }
        }
    });
    std::process::exit(if shutdown_failed.load(Ordering::Acquire) {
        1
    } else {
        code
    });
}
