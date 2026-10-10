# Building an exported Harness release

The source archive contains the exact Harness tree identified by `SOURCE.json`,
without the private repository's history. It includes its GNU GPLv3 license,
build scripts, npm and Cargo lockfiles, dependency notices, and vendored Rust
dependency source. `THIRD-PARTY-NOTICES.txt` preserves the notice text found in
the build's installed dependencies, including frontend and bundled packages.

The archive is not an offline build kit. npm dependencies and the pinned Node
distribution still require downloads. Installed npm packages can contain generated
JavaScript or native binaries rather than their preferred source for modification.
`SOURCE.json` records missing notices and does not claim those packages or bundled
system libraries have a qualified complete corresponding-source distribution.
These obligations must be resolved before a public binary release.

Install Git, a setup Node/npm, and Rust 1.90 or newer. Windows desktop builds also
need Visual Studio C++ build tools and WebView2. macOS needs Xcode command-line
tools; Linux desktop builds need the dependencies described in
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Build each platform
on that platform; a build does not establish support for older OS/libc versions.

After extracting the archive, enter its `harness-<version>` directory and create
a local source identity. Current development tooling expects a Git checkout:

```sh
git init
git add .
git -c user.name="Local builder" -c user.email="builder@example.invalid" commit -m "Import exported Harness source"
npm run runtime:setup
npm run check
npm run dev
```

The new local commit identifies your build; the original release source identity
remains recorded in `SOURCE.json`. The managed runtime setup downloads the exact
Node version pinned in `release/node.json` and installs the frozen npm graph.
Source execution uses a separate `.harness-dev` home by default.

For desktop development or an installer built from the exported source:

```sh
npm run desktop:dev
npm run desktop:build
```

For standalone complete development CLI/server payloads:

```sh
npm run release:payloads
```

These ordinary development builds require no project signing secret or paid OS
publisher certificate. They use your local code and immutable source snapshots.
The exported `.cargo/config.toml` resolves both Rust manifests through the included
`third-party/cargo` directory. To modify a vendored crate, use Cargo's `[patch]`
or a path dependency rather than changing a checksum-protected registry source.
Production release commands additionally require a clean release commit, matching
public metadata and a separately held signing key; they are not needed to build,
run, or modify this source.
