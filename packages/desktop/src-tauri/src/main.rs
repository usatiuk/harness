#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appearance;

use harness_desktop::{MAX_FRAME, command, runtime};

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
use tauri_plugin_updater::UpdaterExt;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::ChildStdin,
    sync::{Mutex, Notify, oneshot, watch},
};

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerEvent {
    Started { id: u64 },
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
    helper_runtime: Mutex<Option<Arc<runtime::ServerRuntime>>>,
    shutdown: Mutex<Option<Result<(), String>>>,
    stopping: AtomicBool,
}

impl Bridge {
    async fn shutdown(self: &Arc<Self>) -> Result<(), String> {
        // Window exit and the Windows installer must join the same owned work.
        let mut completed = self.shutdown.lock().await;
        if let Some(result) = completed.as_ref() {
            return result.clone();
        }
        let failures: Vec<_> = [self.close_all().await, release_local_owner(self).await]
            .into_iter()
            .filter_map(Result::err)
            .collect();
        let result = if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        };
        *completed = Some(result.clone());
        result
    }

    async fn begin_operation(
        &self,
    ) -> Result<(u64, watch::Receiver<bool>, oneshot::Sender<()>), String> {
        let mut commands = self.commands.lock().await;
        if self.stopping.load(Ordering::Acquire) {
            return Err("Desktop is shutting down".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (cancel, canceled) = watch::channel(false);
        let (complete, done) = oneshot::channel();
        commands.insert(id, ConnectionCommand { cancel, done });
        Ok((id, canceled, complete))
    }

    async fn finish_operation(&self, id: u64, complete: oneshot::Sender<()>) {
        let _ = complete.send(());
        self.commands.lock().await.remove(&id);
    }

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
    async fn shutdown_cancels_and_awaits_preparation_and_rejects_new_admission() {
        let bridge = Arc::new(Bridge::default());
        let (id, mut canceled, complete) = bridge.begin_operation().await.unwrap();
        let owner = bridge.clone();
        let mut shutdown = tokio::spawn(async move { owner.shutdown().await });
        tokio::select! {
            result = &mut shutdown => panic!("shutdown missed preparation: {result:?}"),
            result = canceled.changed() => result.expect("preparation cancellation"),
        }
        assert!(*canceled.borrow());
        assert!(
            bridge
                .begin_operation()
                .await
                .unwrap_err()
                .contains("shutting down")
        );
        assert!(
            !shutdown.is_finished(),
            "preparation must physically retire before shutdown completes"
        );
        let second = bridge.shutdown();
        tokio::pin!(second);
        tokio::select! {
            biased;
            result = &mut second => panic!("concurrent shutdown missed preparation: {result:?}"),
            _ = std::future::ready(()) => {}
        }
        bridge.finish_operation(id, complete).await;
        shutdown.await.unwrap().unwrap();
        second.await.unwrap();
        assert!(bridge.commands.lock().await.is_empty());
    }

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

async fn prepare_runtime(
    app: &tauri::AppHandle,
    local: bool,
    canceled: watch::Receiver<bool>,
) -> Result<Arc<runtime::ServerRuntime>, String> {
    let payload =
        if cfg!(not(dev)) && env!("HARNESS_BUILD_MODE") == "development" {
            Some(resources(app)?)
        } else {
            None
        };
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    runtime::prepare(
        tokio::process::Command::new(executable),
        payload,
        local,
        canceled,
    )
    .await
    .map(Arc::new)
}

async fn prepare_helper(
    app: &tauri::AppHandle,
    bridge: &Bridge,
    mut canceled: watch::Receiver<bool>,
) -> Result<Arc<runtime::ServerRuntime>, String> {
    let mut slot = tokio::select! {
        slot = bridge.helper_runtime.lock() => slot,
        _ = canceled.changed() => return Err("Connection attempt cancelled".into()),
    };
    if *canceled.borrow() {
        return Err("Connection attempt cancelled".into());
    }
    if let Some(prepared) = slot.as_ref() {
        return Ok(prepared.clone());
    }
    let prepared = prepare_runtime(app, false, canceled).await?;
    *slot = Some(prepared.clone());
    Ok(prepared)
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
    let (id, canceled, complete) = bridge.begin_operation().await?;
    let result = async {
        channel
            .send(ConnectionProgress::Started { id })
            .map_err(|error| error.to_string())?;
        execute_connection_command(app, &bridge, command, channel, canceled).await
    }
    .await;
    bridge.finish_operation(id, complete).await;
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
    bridge: &Bridge,
    command: serde_json::Value,
    channel: Channel<ConnectionProgress>,
    canceled: watch::Receiver<bool>,
) -> Result<serde_json::Value, String> {
    if *canceled.borrow() {
        return Err("Connection attempt cancelled".into());
    }
    channel
        .send(ConnectionProgress::Progress {
            message: "Preparing server helper".into(),
        })
        .map_err(|error| error.to_string())?;
    let prepared = prepare_helper(&app, bridge, canceled.clone()).await?;
    let mut process = prepared.command();
    process.arg("--connection-command").arg(command.to_string());
    command::execute(
        process,
        canceled,
        |message| {
            channel
                .send(ConnectionProgress::Progress { message })
                .map_err(|error| error.to_string())
        },
        None,
    )
    .await
}
#[tauri::command]
async fn server_connect(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Arc<Bridge>>,
    channel: Channel<ServerEvent>,
    host: serde_json::Value,
    runtime: Option<serde_json::Value>,
) -> Result<u64, String> {
    let (id, canceled, complete) = bridge.begin_operation().await?;
    let result = connect_server(&app, &bridge, channel, host, runtime, id, canceled).await;
    bridge.finish_operation(id, complete).await;
    result
}

async fn connect_server(
    app: &tauri::AppHandle,
    bridge: &Arc<Bridge>,
    channel: Channel<ServerEvent>,
    host: serde_json::Value,
    runtime: Option<serde_json::Value>,
    id: u64,
    canceled: watch::Receiver<bool>,
) -> Result<u64, String> {
    channel
        .send(ServerEvent::Started { id })
        .map_err(|error| error.to_string())?;
    let local = host["kind"] == "local";
    let helper = prepare_helper(app, bridge, canceled.clone()).await?;
    let prepared = if local {
        prepare_runtime(app, true, canceled.clone()).await?
    } else {
        helper
    };
    // Publish every spawned bridge before shutdown takes its snapshot.
    let mut servers = bridge.servers.lock().await;
    if bridge.stopping.load(Ordering::Acquire) || *canceled.borrow() {
        return Err("Desktop is shutting down".into());
    }
    let mut command = prepared.command();
    command
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
        .map_err(|error| format!("Could not start the prepared Harness bridge: {error}"))?;
    let input = Arc::new(Mutex::new(Some(
        child.stdin.take().expect("spawned piped stdin"),
    )));
    let output = child.stdout.take().expect("spawned piped stdout");
    let error = child.stderr.take().expect("spawned piped stderr");
    let (stop, stopped) = oneshot::channel();
    let (complete, done) = watch::channel(None);
    let owner_input = input.clone();
    let credit = Arc::new(Notify::new());
    let (cancel, canceled) = watch::channel(false);
    let owner_cancel = cancel.clone();
    let reader_credit = credit.clone();
    let local_owner = (host["kind"] == "local").then(|| bridge.clone());
    tauri::async_runtime::spawn(async move {
        let _prepared = prepared;
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
async fn release_local_owner(bridge: &Bridge) -> Result<(), String> {
    let Some(identity) = bridge.exit_owner.lock().await.clone() else {
        return Ok(());
    };
    let prepared = bridge
        .helper_runtime
        .lock()
        .await
        .clone()
        .ok_or("Local owner has no prepared control helper")?;
    let mut process = prepared.command();
    process
        .arg("--connection-command")
        .arg(serde_json::json!({"type":"desktop.exit", "identity":identity}).to_string());
    let (_cancel, canceled) = watch::channel(false);
    command::execute(process, canceled, |_| Ok(()), Some(Duration::from_secs(25))).await?;
    Ok(())
}
#[tauri::command]
async fn desktop_update(
    app: tauri::AppHandle,
    version: Option<String>,
) -> Result<Option<String>, String> {
    if env!("HARNESS_BUILD_MODE") != "release" {
        return Err("Development builds update by rebuilding the app.".into());
    }
    let before_exit = app.clone();
    let update = app
        .updater_builder()
        .on_before_exit(move || {
            // Windows invokes this before launching the installer, then exits directly.
            if !finish_desktop(&before_exit) {
                before_exit.cleanup_before_exit();
                std::process::exit(1);
            }
        })
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let Some(update) = update else {
        return if version.is_some() {
            Err("This update is no longer available; check for updates again.".into())
        } else {
            Ok(None)
        };
    };
    let offered = update.version.clone();
    if let Some(expected) = version {
        if expected != offered {
            return Err("The offered version changed; check for updates again.".into());
        }
        let bytes = update
            .download(|_, _| {}, || {})
            .await
            .map_err(|error| error.to_string())?;
        if app.state::<Arc<Bridge>>().stopping.load(Ordering::Acquire) {
            return Err("Desktop is shutting down; reopen Harness to update.".into());
        }
        // Installation's synchronous Windows hook drains async bridge work.
        let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|error| error.to_string())?;
        if let Err(error) = installed {
            let stopped = app.state::<Arc<Bridge>>().stopping.load(Ordering::Acquire);
            return Err(if stopped {
                format!("{error}. Close and reopen Harness to reconnect.")
            } else {
                error.to_string()
            });
        }
        app.request_restart();
    }
    Ok(Some(offered))
}

fn finish_desktop(app: &tauri::AppHandle) -> bool {
    let bridge = app.state::<Arc<Bridge>>();
    match tauri::async_runtime::block_on(bridge.shutdown()) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("Desktop shutdown failed: {error}");
            false
        }
    }
}

fn main() {
    #[cfg(not(dev))]
    {
        let mut arguments = std::env::args();
        let _executable = arguments.next();
        let command = arguments.next();
        if command.as_deref() == Some("--prepare-runtime") {
            let result = (|| {
                let request = arguments
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("Missing preparation request"))?;
                if arguments.next().is_some() {
                    anyhow::bail!("Unexpected preparation arguments");
                }
                runtime::preparation_process(&request)
            })();
            if let Err(error) = result {
                eprintln!("Runtime preparation failed: {error:#}");
                std::process::exit(1);
            }
            return;
        }
    }
    let mut context = tauri::generate_context!();
    let window = context
        .config_mut()
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main")
        .expect("Desktop main window configuration is missing");
    window.transparent = cfg!(any(windows, target_os = "macos"));
    window.no_redirection_bitmap = cfg!(windows);
    #[cfg(target_os = "macos")]
    {
        window.title_bar_style = tauri::TitleBarStyle::Overlay;
        window.hidden_title = true;
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_decoration::init());
    let builder = if env!("HARNESS_BUILD_MODE") == "release" {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    let application = builder
        .manage(Arc::new(Bridge::default()))
        .setup(appearance::install)
        .invoke_handler(tauri::generate_handler![
            appearance::window_material,
            appearance::window_decorate,
            appearance::window_modal,
            server_connect,
            server_write,
            server_ack,
            server_disconnect,
            desktop_update,
            connection_command,
            cancel_connection_command
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window.app_handle().exit(0);
            }
        })
        .build(context)
        .expect("Could not build the Harness desktop application");
    let code = application.run_return(move |app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if !finish_desktop(app) {
                app.cleanup_before_exit();
                std::process::exit(1);
            }
        }
    });
    std::process::exit(code);
}
