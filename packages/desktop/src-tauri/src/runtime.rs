use harness_bootstrap::{Cache, FileUse, default_home};
use std::{io::Write, path::PathBuf, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command,
    sync::watch,
};

const PREPARATION_FRAME_LIMIT: usize = 16 * 1024;

pub fn build_identity() -> anyhow::Result<harness_bootstrap::BuildIdentity> {
    let release = env!("HARNESS_BUILD_MODE") == "release";
    Ok(harness_bootstrap::BuildIdentity {
        mode: env!("HARNESS_BUILD_MODE").into(),
        product_version: env!("HARNESS_PRODUCT_VERSION").into(),
        source_commit: env!("HARNESS_SOURCE_COMMIT").into(),
        target: harness_bootstrap::host_target()?.into(),
        node_version: harness_bootstrap::NodePin::bundled()?.version,
        release_manifest_url: release.then(|| env!("HARNESS_MANIFEST_URL").into()),
        release_verification_public_key: release.then(|| {
            include_str!("../../../../release/verification-key.pub")
                .trim()
                .into()
        }),
    })
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preparation {
    development_payload: Option<PathBuf>,
    local: bool,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreparedPaths {
    home: PathBuf,
    node: PathBuf,
    entry: PathBuf,
    payload: PathBuf,
    keys: [String; 2],
    selection: Option<String>,
}

/// Runs before any Tauri/window setup. The parent takes over use protection
/// before closing stdin; cancellation can terminate even a blocked OS lock/HTTP read.
pub fn preparation_process(request: &str) -> anyhow::Result<()> {
    let request: Preparation = serde_json::from_str(request)?;
    let prepared = ServerRuntime::prepare_inner(request.development_payload, request.local)?;
    publish_preparation(&prepared)
}

fn publish_preparation(prepared: &ServerRuntime) -> anyhow::Result<()> {
    {
        let mut output = std::io::stdout().lock();
        serde_json::to_writer(&mut output, &prepared.paths())?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    std::io::copy(&mut std::io::stdin(), &mut std::io::sink())?;
    Ok(())
}

pub async fn prepare(
    mut command: Command,
    development_payload: Option<PathBuf>,
    local: bool,
    canceled: watch::Receiver<bool>,
) -> Result<ServerRuntime, String> {
    command.arg("--prepare-runtime").arg(
        serde_json::to_string(&Preparation {
            development_payload,
            local,
        })
        .expect("preparation request serializes"),
    );
    prepare_using(command, canceled).await
}

async fn prepare_using(
    mut command: Command,
    mut canceled: watch::Receiver<bool>,
) -> Result<ServerRuntime, String> {
    if *canceled.borrow() {
        return Err("Connection attempt cancelled".into());
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let mut output = BufReader::new(child.stdout.take().expect("preparation stdout"));
    let diagnostics = tokio::spawn(crate::command::read_tail(
        child.stderr.take().expect("preparation stderr"),
    ));
    let result = tokio::select! {
        result = async {
            let mut bytes = Vec::new();
            let count = (&mut output).take((PREPARATION_FRAME_LIMIT + 1) as u64)
                .read_until(b'\n', &mut bytes).await.map_err(|error| error.to_string())?;
            if count > PREPARATION_FRAME_LIMIT {
                return Err("Preparation response exceeds limit".into());
            }
            if bytes.last() != Some(&b'\n') {
                return Err("Preparation helper exited before completing its response".into());
            }
            let paths: PreparedPaths = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            // The child still holds both locks. Acquiring shared guards here
            // cannot race exclusive pruning between descriptor delivery and use.
            let guards = [
                FileUse::shared(&paths.home, &paths.keys[0]).map_err(|error| error.to_string())?,
                FileUse::shared(&paths.home, &paths.keys[1]).map_err(|error| error.to_string())?,
            ];
            let prepared = ServerRuntime::from_paths(paths, guards);
            child.stdin.take();
            let status = child.wait().await.map_err(|error| error.to_string())?;
            if !status.success() {
                return Err(format!("Runtime preparation exited with {status}"));
            }
            Ok(prepared)
        } => result,
        _ = canceled.changed() => Err("Connection attempt cancelled".into()),
    };
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        child.kill().await.map_err(|error| error.to_string())?;
    }
    let diagnostics = diagnostics.await.map_err(|error| error.to_string())??;
    result.map_err(|error: String| {
        if diagnostics.is_empty() {
            error
        } else {
            format!("{error}: {diagnostics}")
        }
    })
}

/// Every helper owns its prepared files until its physical process exit.
pub struct ServerRuntime {
    pub home: PathBuf,
    node: PathBuf,
    entry: PathBuf,
    payload: PathBuf,
    keys: [String; 2],
    selection: Option<String>,
    _guards: [FileUse; 2],
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path, time::Duration};
    use tokio::sync::watch;

    // Copy the complete verified runtime, preserving immutable file bytes. The
    // source guard stays held until the isolated-home preparation has finished.
    fn link_tree(source: &Path, destination: &Path) -> anyhow::Result<()> {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let target = destination.join(entry.file_name());
            let kind = entry.file_type()?;
            if kind.is_dir() {
                link_tree(&entry.path(), &target)?;
            } else if kind.is_symlink() {
                #[cfg(unix)]
                std::os::unix::fs::symlink(fs::read_link(entry.path())?, target)?;
                #[cfg(windows)]
                anyhow::bail!("Unexpected link in the Windows Node distribution");
            } else {
                fs::hard_link(entry.path(), target)?;
            }
        }
        Ok(())
    }

    #[tokio::test]
    async fn prepared_desktop_helper_uses_exact_node_payload_home_and_use_guards() {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let source = Cache::new(&workspace.join(".harness-dev")).expect("development cache");
        let node = source.prepare_node().expect("verified development Node");
        let staging = source.home.join("staging");
        fs::create_dir_all(&staging).expect("test staging");
        let root = tempfile::tempdir_in(staging).expect("test directory");
        let cache = Cache::new(&root.path().join("home")).expect("isolated home");
        let name = node.directory.file_name().expect("Node cache identity");
        link_tree(&node.directory, &cache.home.join("runtime/node").join(name))
            .expect("complete runtime copy");
        let prepared = ServerRuntime::prepare_at(
            &cache.home,
            Some(workspace.join("packages/desktop/resources")),
            true,
        )
        .expect("actual complete development preparation");
        let mut command = prepared.command();
        assert_eq!(command.as_std().get_program(), prepared.node.as_os_str());
        assert_eq!(
            command.as_std().get_args().next(),
            Some(prepared.entry.as_os_str())
        );
        let environment: std::collections::HashMap<_, _> = command.as_std().get_envs().collect();
        assert_eq!(
            environment[std::ffi::OsStr::new("HARNESS_HOME")],
            Some(cache.home.as_os_str())
        );
        assert_eq!(
            environment[std::ffi::OsStr::new("HARNESS_NATIVE_BINDING")],
            None
        );
        let descriptor: serde_json::Value = serde_json::from_str(
            environment[std::ffi::OsStr::new("HARNESS_PREPARED_SERVER")]
                .unwrap()
                .to_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(descriptor["node"], prepared.node.to_str().unwrap());
        assert_eq!(descriptor["entry"], prepared.entry.to_str().unwrap());
        assert_eq!(descriptor["payload"], prepared.payload.to_str().unwrap());
        for key in &prepared.keys {
            assert!(FileUse::try_exclusive(&cache.home, key).unwrap().is_none());
        }
        command
            .arg("--connection-command")
            .arg(r#"{"type":"config.read"}"#);
        let (_cancel, canceled) = watch::channel(false);
        let result =
            crate::command::execute(command, canceled, |_| Ok(()), Some(Duration::from_secs(30)))
                .await
                .expect("real helper command");
        assert_eq!(result["version"], 1);
        assert_eq!(result["selectedHostId"], "local");
        let mut command = prepared.command();
        command
            .arg("--connection-command")
            .arg(r#"{"type":"preferences","keepServerRunning":true}"#);
        let (_cancel, canceled) = watch::channel(false);
        let saved =
            crate::command::execute(command, canceled, |_| Ok(()), Some(Duration::from_secs(30)))
                .await
                .expect("real preferences command");
        assert_eq!(saved["desktop"]["keepServerRunning"], true);
        assert!(cache.home.join("client.json").is_file());
        let keys = prepared.keys.clone();
        drop(prepared);
        for key in &keys {
            assert!(
                FileUse::try_exclusive(&cache.home, key).unwrap().is_some(),
                "{key}"
            );
        }
    }
}

impl ServerRuntime {
    fn paths(&self) -> PreparedPaths {
        PreparedPaths {
            home: self.home.clone(),
            node: self.node.clone(),
            entry: self.entry.clone(),
            payload: self.payload.clone(),
            keys: self.keys.clone(),
            selection: self.selection.clone(),
        }
    }

    fn from_paths(paths: PreparedPaths, guards: [FileUse; 2]) -> Self {
        Self {
            home: paths.home,
            node: paths.node,
            entry: paths.entry,
            payload: paths.payload,
            keys: paths.keys,
            selection: paths.selection,
            _guards: guards,
        }
    }

    fn prepare_inner(development_payload: Option<PathBuf>, local: bool) -> anyhow::Result<Self> {
        let requested_home = if let Some(home) = std::env::var_os("HARNESS_HOME") {
            PathBuf::from(home)
        } else if development_payload.is_some() {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.harness-dev")
        } else {
            default_home()?
        };
        Self::prepare_at(&requested_home, development_payload, local)
    }

    fn prepare_at(
        requested_home: &std::path::Path,
        development_payload: Option<PathBuf>,
        local: bool,
    ) -> anyhow::Result<Self> {
        let cache = Cache::new(requested_home)?;
        let (node, payload, entry, server_guard, server_key) =
            if let Some(payload) = development_payload {
                let prepared = cache.prepare_development_server(&payload)?;
                let server = prepared.server;
                let key = format!(
                    "server-dev-{}-{}",
                    server.receipt.target, server.receipt.digest
                );
                (
                    prepared.node,
                    server.directory,
                    server.entry,
                    server.usage,
                    key,
                )
            } else {
                let prepared = if local {
                    cache.prepare_selected_server(
                        env!("HARNESS_PRODUCT_VERSION"),
                        env!("HARNESS_RELEASE_BASE_URL"),
                        include_str!("../../../../release/verification-key.pub"),
                    )?
                } else {
                    cache.prepare_server_release(
                        env!("HARNESS_PRODUCT_VERSION"),
                        env!("HARNESS_MANIFEST_URL"),
                        include_str!("../../../../release/verification-key.pub"),
                    )?
                };
                if !local && prepared.manifest.source_commit != env!("HARNESS_SOURCE_COMMIT") {
                    anyhow::bail!("Release metadata does not match the desktop source identity");
                }
                let server = prepared.server;
                let key = format!(
                    "server-{}-{}",
                    server.receipt.version, server.receipt.target
                );
                (
                    prepared.node,
                    server.directory,
                    server.entry,
                    server.usage,
                    key,
                )
            };
        let selection = local.then(|| {
            payload
                .file_name()
                .expect("prepared payload directory")
                .to_str()
                .expect("Unicode payload identity")
                .to_owned()
        });
        let node_key = format!("node-{}-{}", node.receipt.version, node.receipt.target);
        Ok(Self {
            home: cache.home,
            node: node.entry,
            entry,
            payload,
            selection,
            keys: [node_key, server_key],
            _guards: [node.usage, server_guard],
        })
    }

    pub fn command(&self) -> Command {
        let descriptor = serde_json::json!({
            "node": self.node,
            "entry": self.entry,
            "payload": self.payload,
            "keys": self.keys,
        });
        let mut command = Command::new(&self.node);
        command
            .arg(&self.entry)
            .env_remove("HARNESS_NATIVE_BINDING")
            .env_remove("HARNESS_SERVER_SELECTION")
            .env("HARNESS_HOME", &self.home)
            .env(
                "HARNESS_SERVER_CACHE_KEYS",
                serde_json::to_string(&self.keys).expect("cache keys serialize"),
            )
            .env("HARNESS_PREPARED_SERVER", descriptor.to_string());
        if let Some(selection) = &self.selection {
            command.env("HARNESS_SERVER_SELECTION", selection);
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        command
    }
}
