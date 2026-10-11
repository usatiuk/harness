#[cfg(not(dev))]
use harness_bootstrap::{Cache, default_home};
#[cfg(not(dev))]
use std::io::Write;
use std::path::PathBuf;
use tokio::{process::Command, sync::watch};

fn workspace() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

#[cfg(not(dev))]
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preparation {
    home: PathBuf,
    development_payload: Option<PathBuf>,
    local: bool,
}

#[cfg(not(dev))]
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreparedPaths {
    node: PathBuf,
    entry: PathBuf,
    payload: PathBuf,
}

/// This mode runs before Tauri setup. EOF cancels blocking downloads/OS locks.
#[cfg(not(dev))]
pub fn preparation_process(request: &str) -> anyhow::Result<()> {
    let request: Preparation = serde_json::from_str(request)?;
    std::thread::spawn(|| {
        let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
        std::process::exit(1);
    });
    let cache = Cache::new(&request.home)?;
    let (node, payload, entry) = if let Some(payload) = request.development_payload {
        let prepared = cache.prepare_development_server(&payload)?;
        (
            prepared.node.entry,
            prepared.server.directory,
            prepared.server.entry,
        )
    } else {
        let prepared = if request.local {
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
        (
            prepared.node.entry,
            prepared.server.directory,
            prepared.server.entry,
        )
    };
    serde_json::to_writer(
        std::io::stdout(),
        &PreparedPaths {
            node,
            entry,
            payload,
        },
    )?;
    std::io::stdout().write_all(b"\n")?;
    Ok(())
}

/// Installed builds own a cache lease; source development runs the workspace directly.
pub async fn prepare(
    command: Command,
    development_payload: Option<PathBuf>,
    local: bool,
    canceled: watch::Receiver<bool>,
) -> Result<ServerRuntime, String> {
    if *canceled.borrow() {
        return Err("Connection attempt cancelled".into());
    }
    let requested_home = command
        .as_std()
        .get_envs()
        .find_map(|(key, value)| (key == "HARNESS_HOME").then_some(value).flatten())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HARNESS_HOME").map(PathBuf::from));
    #[cfg(dev)]
    {
        let _ = (development_payload, local);
        Ok(ServerRuntime {
            home: requested_home.unwrap_or_else(|| workspace().join(".harness-dev/source")),
            node: std::env::var_os("HARNESS_DEVELOPMENT_NODE")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("node")),
        })
    }
    #[cfg(not(dev))]
    {
        let home = match requested_home {
            Some(home) => home,
            None if development_payload.is_some() => workspace().join(".harness-dev"),
            None => default_home().map_err(|error| error.to_string())?,
        };
        let cache = Cache::new(&home).map_err(|error| error.to_string())?;
        let mut command = command;
        command.arg("--prepare-runtime").arg(
            serde_json::to_string(&Preparation {
                home: cache.home.clone(),
                development_payload,
                local,
            })
            .expect("preparation request serializes"),
        );
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let value = crate::command::execute(command, canceled, |_| Ok(()), None).await?;
        let paths = serde_json::from_value(value).map_err(|error| error.to_string())?;
        Ok(ServerRuntime { cache, paths })
    }
}

#[cfg(not(dev))]
pub struct ServerRuntime {
    cache: Cache,
    paths: PreparedPaths,
}

#[cfg(dev)]
pub struct ServerRuntime {
    home: PathBuf,
    node: PathBuf,
}

impl ServerRuntime {
    pub fn command(&self) -> Command {
        #[cfg(dev)]
        let (mut command, home) = {
            let mut command = Command::new(&self.node);
            command
                .args(["--conditions=development", "--import=tsx"])
                .arg(workspace().join("packages/server/src/bin.ts"))
                .current_dir(workspace())
                .env_remove("HARNESS_PREPARED_SERVER");
            (command, &self.home)
        };
        #[cfg(not(dev))]
        let (mut command, home) = {
            let mut command = Command::new(&self.paths.node);
            command.arg(&self.paths.entry)
                .env_remove("HARNESS_NATIVE_BINDING")
                .env("HARNESS_PREPARED_SERVER", serde_json::json!({
                    "node": self.paths.node, "entry": self.paths.entry, "payload": self.paths.payload,
                }).to_string());
            (command, &self.cache.home)
        };
        command
            .env("HARNESS_HOME", home)
            .env_remove("HARNESS_SERVER_SELECTION");
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        command
    }
}
