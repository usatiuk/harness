use anyhow::{Context, Result, bail};
use harness_bootstrap::{Cache, InstalledArtifact, default_home};
use std::{ffi::OsString, path::Path, process::Command};
mod preparation;
use preparation::PreparationConnection;

const KEY: &str = include_str!("../../../release/verification-key.pub");

fn run() -> Result<i32> {
    let mut args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let command = args
        .first()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_owned();
    if command == "--version" {
        println!("{}", env!("HARNESS_PRODUCT_VERSION"));
        return Ok(0);
    }
    let helper = matches!(
        command.as_str(),
        "--prepare-server" | "--inspect-cached-server" | "--install-development-server"
    );
    let remote = helper && args.last().is_some_and(|arg| arg == "--remote");
    if remote {
        args.pop();
    }
    // Only preparation reads stdin for cancellation. A bridge's stdin is the protocol.
    let connection = remote.then(PreparationConnection::new).transpose()?;
    let cache = Cache::new(&default_home()?)?;
    match command.as_str() {
        "--prepare-server" => {
            exact(&args, 2)?;
            let prepared = cache.prepare_selected_server(
                text_arg(&args, 1)?,
                env!("HARNESS_RELEASE_BASE_URL"),
                KEY,
            )?;
            publish(&cache, &prepared.node, &prepared.server, false, connection)
        }
        "--install-development-server" => {
            if option_env!("HARNESS_RELEASE_BUILD") == Some("1") {
                bail!("Release bootstrap does not accept source-build servers");
            }
            exact(&args, 3)?;
            let prepared =
                cache.install_development_server(Path::new(&args[1]), text_arg(&args, 2)?)?;
            publish(&cache, &prepared.node, &prepared.server, true, connection)
        }
        "--server" | "--run-cached-server" | "--inspect-cached-server" => {
            let inspect = command == "--inspect-cached-server";
            exact(
                &args,
                if command == "--run-cached-server" {
                    3
                } else {
                    2
                },
            )?;
            let directory = if command == "--server" {
                let version = cache
                    .selected_server_version()?
                    .unwrap_or(env!("HARNESS_PRODUCT_VERSION").into());
                format!("{version}-{}", harness_bootstrap::host_target()?)
            } else {
                text_arg(&args, 1)?.into()
            };
            let mode = if inspect {
                None
            } else {
                Some(text_arg(&args, if command == "--server" { 1 } else { 2 })?)
            };
            if mode.is_some_and(|mode| {
                !matches!(
                    mode,
                    "--bridge" | "--attach-only" | "--background" | "--stdio"
                )
            }) {
                bail!("Invalid server mode");
            }
            let target = harness_bootstrap::host_target()?;
            if let Some(digest) = directory.strip_prefix(&format!("dev-{target}-")) {
                if option_env!("HARNESS_RELEASE_BUILD") == Some("1") {
                    bail!("Release bootstrap does not accept source-build servers");
                }
                let prepared = cache.prepare_cached_development_server(digest)?;
                if inspect {
                    publish(&cache, &prepared.node, &prepared.server, true, connection)
                } else {
                    launch_server(
                        &cache,
                        &prepared.node,
                        &prepared.server,
                        digest,
                        mode.unwrap(),
                    )
                }
            } else {
                let version = directory
                    .strip_suffix(&format!("-{target}"))
                    .context("Cached server is not a release for this platform")?;
                let prepared = cache.prepare_cached_server_release(version, KEY)?;
                if inspect {
                    publish(&cache, &prepared.node, &prepared.server, true, connection)
                } else {
                    launch_server(
                        &cache,
                        &prepared.node,
                        &prepared.server,
                        &prepared.manifest.targets[target].server.sha256,
                        mode.unwrap(),
                    )
                }
            }
        }
        _ => {
            let prepared = cache.prepare_cli_release(
                env!("HARNESS_PRODUCT_VERSION"),
                env!("HARNESS_MANIFEST_URL"),
                KEY,
            )?;
            if prepared.manifest.source_commit != env!("HARNESS_SOURCE_COMMIT") {
                bail!("Release metadata differs from this launcher's source identity");
            }
            let mut process = Command::new(&prepared.node.entry);
            process.env_remove("HARNESS_SERVER_SELECTION");
            process
                .env_remove("HARNESS_NATIVE_BINDING")
                .env_remove("HARNESS_DEVELOPMENT_SERVER_PAYLOAD")
                .arg(&prepared.cli.entry)
                .args(args)
                .env("HARNESS_HOME", &cache.home)
                .env("HARNESS_NATIVE_LAUNCHER", std::env::current_exe()?);
            Ok(wait_for_child(&mut process)?.code().unwrap_or(1))
        }
    }
}

fn text_arg(args: &[OsString], index: usize) -> Result<&str> {
    args.get(index)
        .and_then(|arg| arg.to_str())
        .context("Missing or non-Unicode argument")
}
fn exact(args: &[OsString], count: usize) -> Result<()> {
    if args.len() != count {
        bail!("Unexpected bootstrap arguments");
    }
    Ok(())
}
fn publish(
    cache: &Cache,
    node: &InstalledArtifact,
    server: &InstalledArtifact,
    home: bool,
    connection: Option<PreparationConnection>,
) -> Result<i32> {
    use std::io::Write;
    let mut result =
        serde_json::json!({"node":node.entry,"entry":server.entry,"payload":server.directory});
    if home {
        result["home"] = serde_json::json!(cache.home);
    }
    if let Some(connection) = connection {
        connection.ready();
    }
    println!("{result}");
    std::io::stdout().flush()?;
    Ok(0)
}
fn launch_server(
    cache: &Cache,
    node: &InstalledArtifact,
    server: &InstalledArtifact,
    build_id: &str,
    mode: &str,
) -> Result<i32> {
    let selection = server
        .directory
        .file_name()
        .context("Cached server has no directory identity")?;
    let mut process = Command::new(&node.entry);
    process
        .arg(&server.entry)
        .arg(mode)
        .env_remove("HARNESS_NATIVE_BINDING")
        .env("HARNESS_HOME", &cache.home)
        .env("HARNESS_SERVER_SELECTION", selection)
        .env("HARNESS_BUILD_ID", build_id);
    // Cache owns the shared lifetime lease until Node has physically exited.
    Ok(wait_for_child(&mut process)?.code().unwrap_or(1))
}
#[cfg(windows)]
fn wait_for_child(process: &mut Command) -> Result<std::process::ExitStatus> {
    unsafe {
        // Children retain their Ctrl+C handling while the waiting parent holds
        // cache use locks through physical exit.
        use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
        unsafe extern "system" fn parent_control(event: u32) -> i32 {
            i32::from(event == 0 || event == 1)
        }
        if SetConsoleCtrlHandler(Some(parent_control), 1) == 0 {
            bail!("Cannot preserve launcher console lifetime");
        }
    }
    // Preserve the caller's console for the interactive CLI.
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
