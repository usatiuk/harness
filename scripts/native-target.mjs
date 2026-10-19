import process from "node:process";

/** Node and Rust outputs must describe the same qualified host target. */
export function nativeTarget() {
  const target = {
    "win32-x64": {
      release: "windows-x64",
      rust: "x86_64-pc-windows-msvc",
      library: "harness_native.dll",
    },
    "linux-x64": {
      release: "linux-x64-glibc",
      rust: "x86_64-unknown-linux-gnu",
      library: "libharness_native.so",
    },
    "linux-arm64": {
      release: "linux-arm64-glibc",
      rust: "aarch64-unknown-linux-gnu",
      library: "libharness_native.so",
    },
    "darwin-arm64": {
      release: "macos-arm64",
      rust: "aarch64-apple-darwin",
      library: "libharness_native.dylib",
    },
    "darwin-x64": {
      release: "macos-x64",
      rust: "x86_64-apple-darwin",
      library: "libharness_native.dylib",
    },
  }[`${process.platform}-${process.arch}`];
  if (!target) throw new Error("Unsupported Harness native host target");
  return target;
}
