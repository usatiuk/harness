#!/usr/bin/env bash
set -euo pipefail
target=${1:?Pass a release target}
executable_suffix=""
if [[ $target == windows-x64 ]]; then
  executable_suffix=.exe
fi
payload_directory="release/output/$target"
asset_directory="release/staging/$target"
mkdir -p "$asset_directory"

product_version=$(node -p 'require("./package.json").version')
asset_prefix="harness-v$product_version-$target"

# Build and archive the server and CLI payloads separately.
node scripts/build-payloads.mjs --release
for component in server cli; do
  tar -czf "$asset_directory/$asset_prefix-$component.tar.gz" \
    -C "$payload_directory" "$component"
done
cp "$payload_directory/server/harness-bootstrap$executable_suffix" \
  "$asset_directory/harness-${target%-glibc}$executable_suffix"

# Tauri owns the platform installer and its update signature.
case "$target" in
  windows-x64)
    bundle=nsis
    installer_extension=.exe
    ;;
  linux-x64-glibc)
    bundle=appimage
    installer_extension=.AppImage
    ;;
  macos-arm64|macos-x64)
    bundle=dmg
    installer_extension=.dmg
    ;;
  *)
    echo "Unsupported release target: $target" >&2
    exit 1
    ;;
esac
bundle_targets="$bundle"
if [[ $target == macos-* ]]; then
  bundle_targets=app,dmg
fi
public_key=$(cat release/verification-key.pub)
tauri_config="release/output/tauri.release.json"
cat > "$tauri_config" <<JSON
{
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "$public_key",
      "requireSignedVersion": true,
      "endpoints": ["https://github.com/usatiuk/harness/releases/latest/download/latest.json"]
    }
  }
}
JSON
npm run desktop:release --workspace @harness/desktop -- \
  --ci --bundles "$bundle_targets" --config "../../$tauri_config"
node scripts/check-desktop-package.mjs \
  "packages/desktop/src-tauri/target/release/harness-desktop$executable_suffix"

# Give the one installer a stable release asset name.
shopt -s nullglob
bundle_directory="packages/desktop/src-tauri/target/release/bundle"
installers=("$bundle_directory/$bundle"/*"$installer_extension")
if [[ ${#installers[@]} != 1 ]]; then
  echo "Expected one $bundle installer, found ${#installers[@]}" >&2
  exit 1
fi
cp "${installers[0]}" "$asset_directory/$asset_prefix-desktop$installer_extension"

# macOS updates use an app archive; Windows and Linux use the installer itself.
update_artifact=${installers[0]}
update_extension=$installer_extension
if [[ $target == macos-* ]]; then
  app_archives=("$bundle_directory/macos"/*.app.tar.gz)
  if [[ ${#app_archives[@]} != 1 ]]; then
    echo "Expected one macOS update archive, found ${#app_archives[@]}" >&2
    exit 1
  fi
  update_artifact=${app_archives[0]}
  update_extension=.app.tar.gz
  cp "$update_artifact" "$asset_directory/$asset_prefix-desktop$update_extension"
fi
cp "$update_artifact.sig" "$asset_directory/$asset_prefix-desktop$update_extension.sig"

node "$payload_directory/cli/cli.mjs" --version
# Tar preserves executable modes and symlinks across GitHub Actions artifact transfer.
tar -czf "release/staging/$target.tar.gz" -C "$asset_directory" .
