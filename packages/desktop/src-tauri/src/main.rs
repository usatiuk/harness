#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
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
    done: watch::Receiver<Option<Result<(), String>>>,
}

struct ConnectionCommand {
    cancel: watch::Sender<bool>,
    done: oneshot::Receiver<()>,
}

#[derive(Default)]
struct Bridge {
    servers: Mutex<HashMap<u64, Server>>,
    commands: Mutex<HashMap<u64, ConnectionCommand>>,
    next_id: AtomicU64,
    exit_owner: Mutex<Option<serde_json::Value>>,
    stopping: AtomicBool,
}

impl Bridge {
    async fn close(&self, id: u64) -> Result<(), String> {
        let (already_exited, mut done) = {
            let mut servers = self.servers.lock().await;
            let Some(server) = servers.get_mut(&id) else {
                return Ok(());
            };
            let already_exited = server.done.borrow().is_some();
            let _ = server.cancel.send(true);
            if let Some(stop) = server.stop.take() {
                let _ = stop.send(());
            }
            (already_exited, server.done.clone())
        };
        // Keep closing bridges visible to app shutdown. Every caller waits for
        // the same completion before conditional release of the Local owner.
        let result = done
            .wait_for(|result| result.is_some())
            .await
            .map(|result| result.as_ref().expect("completed bridge result").clone())
            .map_err(|_| "Bridge owner task failed".to_string());
        self.servers.lock().await.remove(&id);
        let result = result?;
        if already_exited { Ok(()) } else { result }
    }
    async fn close_all(self: &Arc<Self>) -> Result<(), String> {
        self.stopping.store(true, Ordering::Release);
        let commands = std::mem::take(&mut *self.commands.lock().await);
        let ids: Vec<u64> = self.servers.lock().await.keys().copied().collect();
        let mut failures = Vec::new();
        let mut tasks = tokio::task::JoinSet::new();
        for (_, command) in commands {
            let _ = command.cancel.send(true);
            tasks.spawn(async move {
                command
                    .done
                    .await
                    .map_err(|_| "Connection command owner failed".to_string())
            });
        }
        for id in ids {
            let bridge = self.clone();
            tasks.spawn(async move { bridge.close(id).await });
        }
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failures.push(error),
                Err(error) => failures.push(error.to_string()),
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn app_shutdown_waits_for_an_already_closing_bridge() {
        let bridge = Arc::new(Bridge::default());
        let (cancel, mut canceled) = watch::channel(false);
        let (stop, stopped) = oneshot::channel();
        let (complete, done) = watch::channel(None);
        bridge.servers.lock().await.insert(
            1,
            Server {
                id: 1,
                credit: Arc::new(Notify::new()),
                cancel,
                input: Arc::new(Mutex::new(None)),
                stop: Some(stop),
                done,
            },
        );
        let observer = bridge.clone();
        let detach = tokio::spawn(async move { observer.close(1).await });
        stopped.await.expect("disconnect began");
        canceled.borrow_and_update();
        let owner = bridge.clone();
        let mut shutdown = tokio::spawn(async move { owner.close_all().await });
        // A second cancellation signal establishes that shutdown has found the
        // draining observer. Completion must still belong to the bridge owner.
        tokio::select! {
            result = &mut shutdown => panic!("shutdown missed the draining bridge: {result:?}"),
            result = canceled.changed() => result.expect("shutdown found bridge"),
        }
        complete.send(Some(Ok(()))).expect("bridge completion");
        detach.await.expect("detach task").expect("detach result");
        shutdown
            .await
            .expect("shutdown task")
            .expect("shutdown result");
        assert!(bridge.servers.lock().await.is_empty());
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

async fn read_diagnostics(
    error: tokio::process::ChildStderr,
    local_owner: Option<Arc<Bridge>>,
) -> Result<String, String> {
    let mut reader = BufReader::new(error);
    let mut tail = Vec::new();
    loop {
        let mut line = Vec::new();
        let count = (&mut reader)
            .take((MAX_FRAME + 1) as u64)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|_| "Could not read server diagnostics".to_string())?;
        if count == 0 {
            return Ok(String::from_utf8_lossy(&tail).into_owned());
        }
        if count > MAX_FRAME {
            return Err("Server diagnostic line exceeds limit".into());
        }
        if let Some(bridge) = &local_owner {
            if let Ok(event) = serde_json::from_slice::<serde_json::Value>(&line) {
                if event["type"] == "localOwner" {
                    *bridge.exit_owner.lock().await = Some(event["identity"].clone());
                    continue;
                }
            }
        }
        tail.extend_from_slice(&line);
        if tail.len() > 8192 {
            tail.drain(..tail.len() - 8192);
        }
    }
}

fn resources(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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
    Ok(resources)
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ConnectionProgress {
    Started { id: u64 },
    Progress { message: String },
}

#[tauri::command]
async fn connection_command(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Arc<Bridge>>,
    command: serde_json::Value,
    channel: Channel<ConnectionProgress>,
) -> Result<serde_json::Value, String> {
    let mut commands = bridge.commands.lock().await;
    if bridge.stopping.load(Ordering::Acquire) {
        return Err("Desktop is shutting down".into());
    }
    let id = bridge.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (cancel, canceled) = watch::channel(false);
    let (complete, done) = oneshot::channel();
    commands.insert(id, ConnectionCommand { cancel, done });
    drop(commands);
    let result = async {
        channel
            .send(ConnectionProgress::Started { id })
            .map_err(|error| error.to_string())?;
        execute_connection_command(app, command, channel, canceled).await
    }
    .await;
    let _ = complete.send(());
    bridge.commands.lock().await.remove(&id);
    result
}

#[tauri::command]
async fn cancel_connection_command(
    bridge: tauri::State<'_, Arc<Bridge>>,
    id: u64,
) -> Result<(), String> {
    if let Some(command) = bridge.commands.lock().await.get(&id) {
        let _ = command.cancel.send(true);
    }
    Ok(())
}

async fn execute_connection_command(
    app: tauri::AppHandle,
    command: serde_json::Value,
    channel: Channel<ConnectionProgress>,
    mut canceled: watch::Receiver<bool>,
) -> Result<serde_json::Value, String> {
    let directory = resources(&app)?;
    let node = directory
        .join("runtime")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let mut process = Command::new(node);
    process
        .arg(directory.join("server.mjs"))
        .arg("--connection-command")
        .arg(command.to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    process.creation_flags(0x08000000);
    let mut child = process.spawn().map_err(|error| error.to_string())?;
    let output = child.stdout.take().expect("piped command stdout");
    let diagnostics = child.stderr.take().expect("piped command stderr");
    let errors = tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(diagnostics);
        let mut tail = String::new();
        loop {
            let mut line = Vec::new();
            let count = (&mut reader)
                .take(8193)
                .read_until(b'\n', &mut line)
                .await
                .map_err(|error| error.to_string())?;
            if count == 0 {
                return Ok::<String, String>(tail);
            }
            if count > 8192 {
                return Err("Connection diagnostic line exceeds limit".into());
            }
            let text = String::from_utf8_lossy(&line);
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&text) {
                if event["type"] == "progress" {
                    if let Some(message) = event["message"].as_str() {
                        channel
                            .send(ConnectionProgress::Progress {
                                message: message.to_owned(),
                            })
                            .map_err(|error| error.to_string())?;
                    }
                    continue;
                }
            }
            tail.push_str(&text);
            if tail.len() > 8192 {
                tail = tail
                    .chars()
                    .rev()
                    .take(4096)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
            }
        }
    });
    let mut data = Vec::new();
    let mut bounded_output = output.take((MAX_FRAME + 1) as u64);
    tokio::select! {
        result = bounded_output.read_to_end(&mut data) => {
            result.map_err(|error| error.to_string())?;
        },
        _ = canceled.changed() => {
            child.stdin.take();
            match tokio::time::timeout(Duration::from_secs(20), child.wait()).await {
                Ok(result) => { result.map_err(|error| error.to_string())?; },
                Err(_) => { child.kill().await.map_err(|error| error.to_string())?; }
            }
            errors.await.map_err(|error| error.to_string())??;
            return Err("Connection attempt cancelled".into());
        }
    }
    if data.len() > MAX_FRAME {
        return Err("Connection command output exceeds limit".into());
    }
    let status = child.wait().await.map_err(|error| error.to_string())?;
    let diagnostics = errors.await.map_err(|error| error.to_string())??;
    if !status.success() {
        return Err(diagnostics);
    }
    serde_json::from_slice(&data).map_err(|error| error.to_string())
}

#[tauri::command]
async fn server_connect(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Arc<Bridge>>,
    channel: Channel<ServerEvent>,
    host: serde_json::Value,
    runtime: Option<serde_json::Value>,
) -> Result<u64, String> {
    // Publish every spawned bridge before shutdown takes its snapshot.
    let mut servers = bridge.servers.lock().await;
    if bridge.stopping.load(Ordering::Acquire) {
        return Err("Desktop is shutting down".into());
    }
    let resources = resources(&app)?;
    let node = resources
        .join("runtime")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let mut command = Command::new(node);
    command
        .arg(resources.join("server.mjs"))
        .arg("--host-bridge")
        .arg(serde_json::json!({"host": host, "runtime": runtime}).to_string())
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
    let (complete, done) = watch::channel(None);
    let owner_input = input.clone();
    let id = bridge.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let credit = Arc::new(Notify::new());
    let (cancel, canceled) = watch::channel(false);
    let owner_cancel = cancel.clone();
    let reader_credit = credit.clone();
    let local_owner = (host["kind"] == "local").then(|| bridge.inner().clone());
    tauri::async_runtime::spawn(async move {
        let diagnostics = tauri::async_runtime::spawn(read_diagnostics(error, local_owner));
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
                        "Harness bridge did not finish disconnecting within 20 seconds (termination: {killed:?})"
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
            (Ok(status), _, Ok(Ok(diagnostics))) if !status.success() => Err(format!(
                "Harness server exited with {status}. {diagnostics}"
            )),
            (Err(error), _, _) => Err(error),
            (_, Ok(Err(error)), _) => Err(error),
            (_, Err(error), _) => Err(format!("Protocol reader failed: {error}")),
            (_, _, _) => Err("Server diagnostic reader failed".into()),
        };
        let message = match &result {
            Ok(()) => "Harness server disconnected".into(),
            Err(error) => error.clone(),
        };
        let _ = complete.send(Some(result));
        let _ = channel.send(ServerEvent::Closed { message });
    });
    servers.insert(
        id,
        Server {
            id,
            credit,
            cancel,
            input,
            stop: Some(stop),
            done,
        },
    );
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
        let slot = bridge.servers.lock().await;
        let server = slot.get(&id).ok_or("Harness server is disconnected")?;
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
    let slot = bridge.servers.lock().await;
    let server = slot.get(&id).ok_or("Harness server is disconnected")?;
    if server.id != id {
        return Err("Desktop connection is obsolete".into());
    }
    server.credit.notify_one();
    Ok(())
}

#[tauri::command]
async fn server_disconnect(bridge: tauri::State<'_, Arc<Bridge>>, id: u64) -> Result<(), String> {
    bridge.close(id).await
}
async fn release_local_owner(app: &tauri::AppHandle, bridge: &Bridge) -> Result<(), String> {
    let Some(identity) = bridge.exit_owner.lock().await.clone() else {
        return Ok(());
    };
    let resources = resources(app)?;
    let mut command = Command::new(resources.join("runtime").join(if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }));
    command
        .arg(resources.join("server.mjs"))
        .arg("--connection-command")
        .arg(serde_json::json!({"type":"desktop.exit", "identity":identity}).to_string())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(25), command.output())
        .await
        .map_err(|_| "Local exit command exceeded its deadline".to_string())?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
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
            server_disconnect,
            connection_command,
            cancel_connection_command
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
            if let Err(error) = tauri::async_runtime::block_on(bridge.close_all()) {
                eprintln!("Desktop shutdown failed: {error}");
                failure.store(true, Ordering::Release);
            }
            if let Err(error) = tauri::async_runtime::block_on(release_local_owner(app, &bridge)) {
                eprintln!("Local server exit failed: {error}");
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
