use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Component, Path},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub format: ArchiveFormat,
    pub root: String,
    pub entry: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveFormat {
    TarGz,
    Zip,
    File,
}

pub fn relative_path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 512
        || value.contains(['\\', ':', '\0'])
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        bail!("Unsafe payload path: {value:?}");
    }
    Ok(())
}

pub fn version(value: &str) -> Result<()> {
    let parsed = semver::Version::parse(value)?;
    if !parsed.build.is_empty() {
        bail!("Invalid product/runtime version");
    }
    Ok(())
}

impl Artifact {
    pub fn validate(&self) -> Result<()> {
        let url = reqwest::Url::parse(&self.url)?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            bail!("Artifact URL must be HTTPS without credentials or fragments");
        }
        if self.size == 0
            || self.size > 2 * 1024 * 1024 * 1024
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            bail!("Invalid artifact size or SHA-256");
        }
        relative_path(&self.root)?;
        relative_path(&self.entry)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Runtime {
    pub version: String,
    pub artifact: Artifact,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopUpdate {
    pub artifact: Artifact,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseTarget {
    pub minimum_platform: String,
    pub node: Runtime,
    pub server: Artifact,
    pub cli: Artifact,
    pub launcher: Artifact,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<Artifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_update: Option<DesktopUpdate>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseManifest {
    pub format_version: u32,
    pub product_version: String,
    pub source_commit: String,
    pub management_version: u32,
    pub protocol_version: u32,
    pub store_schema_version: u32,
    pub plugin_contracts: BTreeMap<String, String>,
    pub targets: BTreeMap<String, ReleaseTarget>,
}

impl ReleaseManifest {
    pub fn validate(&self) -> Result<()> {
        if self.format_version != 1 || self.management_version != 1 {
            bail!("Unsupported release/management metadata format; upgrade the client");
        }
        version(&self.product_version)?;
        if self.source_commit.len() != 40
            || !self
                .source_commit
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self.protocol_version == 0
            || self.store_schema_version == 0
            || self.targets.is_empty()
        {
            bail!("Invalid release identity or compatibility metadata");
        }
        for (target, value) in &self.targets {
            if !["windows-x64", "linux-x64-glibc", "macos-arm64", "macos-x64"]
                .contains(&target.as_str())
                || value.minimum_platform.is_empty()
            {
                bail!("Unsupported or incomplete release target");
            }
            version(&value.node.version)?;
            value.node.artifact.validate()?;
            value.server.validate()?;
            value.cli.validate()?;
            value.launcher.validate()?;
            if let Some(artifact) = &value.desktop {
                artifact.validate()?;
            }
            if let Some(update) = &value.desktop_update {
                update.artifact.validate()?;
                if update.signature.is_empty() {
                    bail!("Missing desktop update signature");
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildIdentity {
    pub mode: String,
    pub product_version: String,
    pub source_commit: String,
    pub target: String,
    pub node_version: String,
    pub release_manifest_url: Option<String>,
    pub release_verification_public_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodePin {
    pub version: String,
    pub targets: BTreeMap<String, Artifact>,
}

impl NodePin {
    pub fn bundled() -> Result<Self> {
        let pin: Self = serde_json::from_str(include_str!("../../../release/node.json"))?;
        version(&pin.version)?;
        for artifact in pin.targets.values() {
            artifact.validate()?;
        }
        Ok(pin)
    }
}

pub fn host_target() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok("windows-x64"),
        ("linux", "x86_64") if !cfg!(target_env = "musl") => Ok("linux-x64-glibc"),
        ("macos", "aarch64") => Ok("macos-arm64"),
        ("macos", "x86_64") => Ok("macos-x64"),
        _ => bail!("Unsupported Harness runtime target"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_shared_descriptor_validation_cases() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../release/fixtures/validation.json"))
                .unwrap();
        for (name, expected) in [("validVersions", true), ("invalidVersions", false)] {
            for value in cases[name].as_array().unwrap() {
                assert_eq!(
                    version(value.as_str().unwrap()).is_ok(),
                    expected,
                    "{value}"
                );
            }
        }
        let pin = NodePin::bundled().unwrap();
        let original = pin.targets.get(host_target().unwrap()).unwrap();
        for (name, expected) in [("validPaths", true), ("invalidPaths", false)] {
            for value in cases[name].as_array().unwrap() {
                let artifact = Artifact {
                    entry: value.as_str().unwrap().into(),
                    ..original.clone()
                };
                assert_eq!(artifact.validate().is_ok(), expected, "{value}");
            }
        }
        for (name, expected) in [("validUrls", true), ("invalidUrls", false)] {
            for value in cases[name].as_array().unwrap() {
                let artifact = Artifact {
                    url: value.as_str().unwrap().into(),
                    ..original.clone()
                };
                assert_eq!(artifact.validate().is_ok(), expected, "{value}");
            }
        }
    }
}
