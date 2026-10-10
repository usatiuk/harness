const path = require("node:path");
const process = require("node:process");
const { Socket } = require("node:net");
const { closeSync } = require("node:fs");
// Source bootstrap captures an immutable compiled binding; installed payloads
// carry their exact target binding beside this loader.
const binding = require(
  process.env.HARNESS_NATIVE_BINDING ??
    path.join(path.dirname(module.filename), "harness-native.node"),
);
if (
  typeof binding.CacheUse !== "function" ||
  typeof binding.LifecycleLock !== "function" ||
  typeof binding.verifyRelease !== "function" ||
  typeof binding.verifyArtifactSignature !== "function" ||
  (process.platform === "win32" && typeof binding.PipeListener !== "function")
)
  throw new Error("Harness native binding is incomplete for this platform");
function adoptPipe(descriptor) {
  let socket;
  try {
    socket = new Socket({ fd: descriptor, readable: true, writable: true });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  return socket;
}
exports.CacheUse = binding.CacheUse;
exports.LifecycleLock = binding.LifecycleLock;
exports.verifyRelease = binding.verifyRelease;
exports.verifyArtifactSignature = binding.verifyArtifactSignature;
exports.PipeListener = binding.PipeListener;
exports.adoptPipe = adoptPipe;
