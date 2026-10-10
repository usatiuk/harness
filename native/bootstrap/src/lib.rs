mod archive;
mod cache;
mod development;
mod home;
mod manifest;
mod payload;
mod preparation;

pub use cache::{Cache, ExclusiveLock, FileUse, InstalledArtifact};
pub use development::PreparedDevelopmentServer;
pub use home::{canonical_home, default_home};
pub use manifest::{
    ArchiveFormat, Artifact, BuildIdentity, NodePin, ReleaseManifest, ReleaseTarget, host_target,
};
pub use preparation::{PreparedCli, PreparedServer};

use anyhow::{Context, Result, bail};
use reqwest::blocking::Client;
use std::{io::Read, time::Duration};

pub fn http_client() -> Result<Client> {
    Ok(Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(180))
        .connect_timeout(Duration::from_secs(20))
        .user_agent(concat!("Harness/", env!("CARGO_PKG_VERSION")))
        .build()?)
}

fn fetch_bounded(client: &Client, url: &str, limit: u64) -> Result<Vec<u8>> {
    let mut response = client.get(url).send()?.error_for_status()?;
    if response.content_length().is_some_and(|size| size > limit) {
        bail!("Download exceeds its size limit");
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut response)
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        bail!("Download exceeds its size limit");
    }
    Ok(bytes)
}

pub(crate) struct VerifiedRelease {
    bytes: Vec<u8>,
    signature: String,
    manifest: ReleaseManifest,
}

fn fetch_verified_release(client: &Client, url: &str, public_key: &str) -> Result<VerifiedRelease> {
    let bytes = fetch_bounded(client, url, 1024 * 1024)?;
    let signature = fetch_bounded(client, &format!("{url}.minisig"), 16 * 1024)?;
    let signature = String::from_utf8(signature)?;
    let manifest = verify_release(&bytes, &signature, public_key)?;
    Ok(VerifiedRelease {
        bytes,
        signature,
        manifest,
    })
}

pub fn verify_release(bytes: &[u8], signature: &str, public_key: &str) -> Result<ReleaseManifest> {
    verify_signature(bytes, signature, public_key)?;
    let manifest: ReleaseManifest = serde_json::from_slice(bytes)?;
    manifest.validate()?;
    Ok(manifest)
}

/// The same project signature format protects metadata and Tauri updater bytes.
pub fn verify_signature(bytes: &[u8], signature: &str, public_key: &str) -> Result<()> {
    use base64::Engine;
    // Tauri's signer stores base64-wrapped Minisign text, not the raw key/signature lines.
    let key_bytes = base64::engine::general_purpose::STANDARD.decode(public_key.trim())?;
    let signature_bytes = base64::engine::general_purpose::STANDARD.decode(signature.trim())?;
    let key = minisign_verify::PublicKey::decode(std::str::from_utf8(&key_bytes)?)
        .context("Invalid release verification key")?;
    let signature = minisign_verify::Signature::decode(std::str::from_utf8(&signature_bytes)?)
        .context("Invalid release signature")?;
    key.verify(bytes, &signature, false)
        .context("Release signature verification failed")
}
