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
#[serde(rename_all = "camelCase")]
pub struct ReleaseTarget {
    pub node: Runtime,
    pub server: Artifact,
    pub cli: Artifact,
    pub launcher: Artifact,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub format_version: u32,
    pub product_version: String,
    pub targets: BTreeMap<String, ReleaseTarget>,
}

impl ReleaseManifest {
    pub fn validate(&self) -> Result<()> {
        if self.format_version != 1 {
            bail!("Unsupported release metadata format; upgrade the client");
        }
        version(&self.product_version)?;
        if self.targets.is_empty() {
            bail!("Release has no supported targets");
        }
        for (target, value) in &self.targets {
            if !["windows-x64", "linux-x64-glibc", "macos-arm64", "macos-x64"]
                .contains(&target.as_str())
            {
                bail!("Unsupported or incomplete release target");
            }
            version(&value.node.version)?;
            value.node.artifact.validate()?;
            value.server.validate()?;
            value.cli.validate()?;
            value.launcher.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildIdentity {
    pub mode: String,
    pub product_version: String,
    pub target: String,
    pub node_version: String,
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
