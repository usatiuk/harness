use anyhow::{Context, Result, bail};
use harness_bootstrap::{Cache, ServerTransfer, default_home};
use std::{path::PathBuf, process::Command};
mod preparation;
use preparation::PreparationConnection;

fn run() -> Result<i32> {
    let mut args = std::env::args_os().skip(1);
    let command = args.next();
    if command.as_deref() == Some(std::ffi::OsStr::new("--version")) {
        println!("{}", env!("HARNESS_PRODUCT_VERSION"));
        return Ok(0);
    }
    if command.as_deref() == Some(std::ffi::OsStr::new("--build-info")) {
        if args.next().is_some() {
            bail!("Unexpected build-info argument");
        }
        let release = option_env!("HARNESS_RELEASE_BUILD") == Some("1");
        println!(
            "{}",
            serde_json::json!({
                "mode": if release { "release" } else { "development" },
                "productVersion": env!("HARNESS_PRODUCT_VERSION"),
                "sourceCommit": env!("HARNESS_SOURCE_COMMIT"),
                "target": harness_bootstrap::host_target()?,
                "nodeVersion": harness_bootstrap::NodePin::bundled()?.version,
                "releaseManifestUrl": release.then_some(env!("HARNESS_MANIFEST_URL")),
                "releaseVerificationPublicKey": release.then_some(include_str!("../../../release/verification-key.pub").trim()),
            })
        );
        return Ok(0);
    }
    let cache = Cache::new(&default_home()?)?;
    match command.as_ref().and_then(|value| value.to_str()) {
        Some("--run-cached-server") | Some("--inspect-cached-server") => {
            let directory = args.next().context("Missing cached server directory")?;
            let directory = directory
                .to_str()
                .context("Invalid cached server directory")?;
            let mode = if command.as_deref() == Some(std::ffi::OsStr::new("--run-cached-server")) {
                let mode = args.next().context("Missing cached server launch mode")?;
                if mode != "--bridge" && mode != "--attach-only" {
                    bail!("Invalid cached server launch mode");
                }
                Some(mode)
            } else {
                None
            };
            if args.next().is_some() {
                bail!("Unexpected cached server argument");
            }
            let connection = mode
                .is_none()
                .then(PreparationConnection::new)
                .transpose()?;
            let target = harness_bootstrap::host_target()?;
            if let Some(digest) = directory.strip_prefix(&format!("dev-{target}-")) {
                if option_env!("HARNESS_RELEASE_BUILD") == Some("1") {
                    bail!("Release bootstrap does not accept source-build servers");
                }
                let prepared = cache.prepare_cached_development_server(digest)?;
                cached_server_command(
                    &cache,
                    &prepared.node,
                    &prepared.server.entry,
                    &prepared.server.directory,
                    format!("server-{directory}"),
                    digest,
                    mode.as_deref(),
                    connection,
                )
            } else {
                let version = directory
                    .strip_suffix(&format!("-{target}"))
                    .context("Cached server is not a release for this platform")?;
                let prepared = cache.prepare_cached_server_release(
                    version,
                    include_str!("../../../release/verification-key.pub"),
                )?;
                cached_server_command(
                    &cache,
                    &prepared.node,
                    &prepared.server.entry,
                    &prepared.server.directory,
                    format!("server-{directory}"),
                    &prepared.server.receipt.artifact.sha256,
                    mode.as_deref(),
                    connection,
                )
            }
        }
        Some("--install-transferred-server") => {
            let request = args.next().context("Missing server transfer descriptor")?;
            let request = request.to_str().context("Invalid transfer descriptor")?;
            if request.len() > 16 * 1024 || args.next().is_some() {
                bail!("Invalid server transfer arguments");
            }
            let request: ServerTransfer = serde_json::from_str(request)?;
            let connection = PreparationConnection::new()?;
            match request {
                ServerTransfer::Release(transfer) => {
                    let prepared = cache.install_transferred_release(
                        &transfer,
                        include_str!("../../../release/verification-key.pub"),
                    )?;
                    connection.ready();
                    println!(
                        "{}",
                        serde_json::json!({
                            "home":cache.home,"node":prepared.node.entry,
                            "entry":prepared.server.entry,"payload":prepared.server.directory,
                            "keys":[
                                format!("node-{}-{}", prepared.node.receipt.version, prepared.node.receipt.target),
                                format!("server-{}-{}", prepared.server.receipt.version, prepared.server.receipt.target),
                            ],
                        })
                    );
                    connection.finish()?;
                }
                ServerTransfer::Development(transfer) => {
                    if option_env!("HARNESS_RELEASE_BUILD") == Some("1") {
                        bail!("Release bootstrap does not accept source-build transfers");
                    }
                    let prepared = cache.install_transferred_development_server(
                        &transfer.archive,
                        transfer.size,
                        &transfer.sha256,
                        &transfer.node_archive,
                    )?;
                    connection.ready();
                    println!(
                        "{}",
                        serde_json::json!({
                            "home":cache.home,"node":prepared.node.entry,
                            "entry":prepared.server.entry,"payload":prepared.server.directory,
                            "keys":[
                                format!("node-{}-{}", prepared.node.receipt.version, prepared.node.receipt.target),
                                format!("server-dev-{}-{}", prepared.server.receipt.target, prepared.server.receipt.digest),
                            ],
                        })
                    );
                    connection.finish()?;
                }
            }
            Ok(0)
        }
        Some("--prepare-node") => {
            let node = cache.prepare_node()?;
            println!(
                "{}",
                serde_json::json!({"home":cache.home,"node":node.entry,"directory":node.directory})
            );
            Ok(0)
        }
        Some("--prepare-server") => {
            let version = args.next().context("Missing captured client version")?;
            let version = version.to_str().context("Invalid client version")?;
            if args.next().is_some() {
                bail!("Unexpected server preparation argument");
            }
            let prepared = cache.prepare_selected_server(
                version,
                env!("HARNESS_RELEASE_BASE_URL"),
                include_str!("../../../release/verification-key.pub"),
            )?;
            println!(
                "{}",
                serde_json::json!({
                    "node": prepared.node.entry,
                    "entry": prepared.server.entry,
                    "payload": prepared.server.directory,
                    "keys": [
                        format!("node-{}-{}", prepared.node.receipt.version, prepared.node.receipt.target),
                        format!("server-{}-{}", prepared.server.receipt.version, prepared.server.receipt.target),
                    ],
                })
            );
            retain_preparation()?;
            Ok(0)
        }
        Some("--prepare-development-server") => {
            let payload = PathBuf::from(args.next().context("Missing development server payload")?);
            if args.next().is_some() {
                bail!("Unexpected development preparation argument");
            }
            let prepared = cache.prepare_development_server(&payload)?;
            println!(
                "{}",
                serde_json::json!({
                    "node": prepared.node.entry,
                    "entry": prepared.server.entry,
                    "payload": prepared.server.directory,
                    "keys": [
                        format!("node-{}-{}", prepared.node.receipt.version, prepared.node.receipt.target),
                        format!("server-dev-{}-{}", prepared.server.receipt.target, prepared.server.receipt.digest),
                    ],
                })
            );
            retain_preparation()?;
            Ok(0)
        }
        Some("--development") | Some("--run-node") | Some("--npm") => {
            let root = PathBuf::from(args.next().context("Missing development checkout")?);
            // Node's script entry resolver rejects ordinary Windows paths in
            // verbatim spelling. Preserve canonical identity in its normal form.
            #[cfg(windows)]
            let root = dunce::canonicalize(root)?;
            #[cfg(not(windows))]
            let root = root.canonicalize()?;
            let node = cache.prepare_node()?;
            let mut process = Command::new(&node.entry);
            let mut paths = vec![
                node.entry
                    .parent()
                    .context("Pinned Node has no executable directory")?
                    .to_path_buf(),
            ];
            if let Some(path) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&path));
            }
            // npm's lifecycle scripts and Node subprocesses must not pick a host Node ABI.
            process.env("PATH", std::env::join_paths(paths)?);
            if command.as_deref() == Some(std::ffi::OsStr::new("--development")) {
                process
                    .env_remove("HARNESS_SERVER_ENTRY")
                    .env_remove("HARNESS_SERVER_PAYLOAD")
                    .env_remove("HARNESS_SERVER_NODE")
                    .env_remove("HARNESS_SERVER_SELECTION")
                    .env_remove("HARNESS_SERVER_CACHE_KEYS")
                    .env("HARNESS_NATIVE_LAUNCHER", std::env::current_exe()?);
                let entry = root.join("packages/cli/src/bin.ts");
                if !entry.is_file() {
                    bail!("Development CLI entry is missing");
                }
                process
                    .args(["--conditions=development", "--import=tsx"])
                    .arg(entry);
            } else if command.as_deref() == Some(std::ffi::OsStr::new("--npm")) {
                let npm = if cfg!(windows) {
                    node.directory.join("node_modules/npm/bin/npm-cli.js")
                } else {
                    node.directory.join("lib/node_modules/npm/bin/npm-cli.js")
                };
                if !npm.is_file() {
                    bail!("Pinned development runtime has no npm setup tool");
                }
                process.arg(npm);
            }
            process
                .args(args)
                .current_dir(root)
                .env("HARNESS_HOME", &cache.home);
            // Keep this owner alive: its use lock protects the runtime throughout the child lifetime.
            let status = wait_for_child(&mut process)?;
            Ok(status.code().unwrap_or(1))
        }
        _ => {
            let prepared = cache.prepare_cli_release(
                env!("HARNESS_PRODUCT_VERSION"),
                env!("HARNESS_MANIFEST_URL"),
                include_str!("../../../release/verification-key.pub"),
            )?;
            if prepared.manifest.source_commit != env!("HARNESS_SOURCE_COMMIT") {
                bail!("Release metadata does not match this launcher's source identity");
            }
            let mut process = Command::new(&prepared.node.entry);
            process
                .env_remove("HARNESS_NATIVE_BINDING")
                .env_remove("HARNESS_DEVELOPMENT_SERVER_PAYLOAD")
                .env_remove("HARNESS_SERVER_PAYLOAD")
                .env_remove("HARNESS_SERVER_ENTRY")
                .env_remove("HARNESS_SERVER_NODE")
                .env_remove("HARNESS_SERVER_SELECTION")
                .env_remove("HARNESS_SERVER_CACHE_KEYS")
                .arg(&prepared.cli.entry)
                .args(command)
                .args(args)
                .env("HARNESS_HOME", &cache.home)
                .env("HARNESS_NATIVE_LAUNCHER", std::env::current_exe()?);
            let status = wait_for_child(&mut process)?;
            Ok(status.code().unwrap_or(1))
        }
    }
}

fn cached_server_command(
    cache: &Cache,
    node: &harness_bootstrap::InstalledArtifact,
    entry: &std::path::Path,
    directory: &std::path::Path,
    server_key: String,
    build_id: &str,
    mode: Option<&std::ffi::OsStr>,
    connection: Option<PreparationConnection>,
) -> Result<i32> {
    let keys = [
        format!("node-{}-{}", node.receipt.version, node.receipt.target),
        server_key,
    ];
    let Some(mode) = mode else {
        let connection = connection.context("Cached inspection has no preparation connection")?;
        connection.ready();
        println!(
            "{}",
            serde_json::json!({
                "home": cache.home, "node": node.entry, "entry": entry,
                "payload": directory, "keys": keys,
            })
        );
        connection.finish()?;
        return Ok(0);
    };
    let selection = directory
        .file_name()
        .and_then(|value| value.to_str())
        .context("Cached server has no immutable directory identity")?;
    let mut process = Command::new(&node.entry);
    process
        .arg(entry)
        .arg(mode)
        .env_remove("HARNESS_NATIVE_BINDING")
        .env("HARNESS_HOME", &cache.home)
        .env("HARNESS_SERVER_SELECTION", selection)
        .env("HARNESS_SERVER_CACHE_KEYS", serde_json::to_string(&keys)?)
        .env("HARNESS_BUILD_ID", build_id);
    // The caller's prepared values retain both use guards before Node loads
    // native modules, and keep them until the bridge has physically exited.
    Ok(wait_for_child(&mut process)?.code().unwrap_or(1))
}

fn retain_preparation() -> Result<()> {
    use std::io::Write;
    std::io::stdout().flush()?;
    // EOF releases preparation after the client has handed protection to its
    // consumers or awaited their physical exit.
    std::io::copy(&mut std::io::stdin(), &mut std::io::sink())?;
    Ok(())
}

#[cfg(windows)]
fn wait_for_child(process: &mut Command) -> Result<std::process::ExitStatus> {
    unsafe {
        // Both installed and source children retain their Ctrl+C handling.
        // Their waiting parent must retain use locks through physical exit.
        use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
        unsafe extern "system" fn parent_control(event: u32) -> i32 {
            i32::from(event == 0 || event == 1)
        }
        if SetConsoleCtrlHandler(Some(parent_control), 1) == 0 {
            bail!("Cannot preserve launcher console lifetime");
        }
    }
    // Preserve the caller's console, including the development bootstrap's
    // hidden one. Removing it would disrupt the interactive CLI and let npm's
    // shell descendants allocate new console windows.
    Ok(process.status()?)
}

#[cfg(unix)]
fn wait_for_child(process: &mut Command) -> Result<std::process::ExitStatus> {
    use signal_hook::{
        consts::{SIGINT, SIGTERM},
        iterator::Signals,
    };
    let mut signals = Signals::new([SIGINT, SIGTERM])?;
    let handle = signals.handle();
    // Inherit the caller's foreground group so the interactive CLI can read its
    // terminal. Group Ctrl+C reaches the child directly; retain our use guards
    // while it shuts down. Forward explicit termination to the immediate child.
    let mut child = process.spawn()?;
    let pid = i32::try_from(child.id())?;
    let forwarding = std::thread::spawn(move || {
        for signal in signals.forever() {
            if signal == SIGINT {
                continue;
            }
            let result = unsafe { libc::kill(pid, signal) };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error);
                }
            }
        }
        Ok(())
    });
    let status = child.wait();
    handle.close();
    forwarding
        .join()
        .map_err(|_| anyhow::anyhow!("Signal forwarding failed"))??;
    Ok(status?)
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("Harness: {error:#}");
            std::process::exit(1);
        }
    }
}
