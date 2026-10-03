import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers";
import { getQuickJS } from "quickjs-emscripten";

const { code, limits } = workerData;
const QuickJS = await getQuickJS();
const runtime = QuickJS.newRuntime();
runtime.setMemoryLimit(limits.memoryBytes);
runtime.setMaxStackSize(limits.stackBytes);
const vm = runtime.newContext();
let cpuRemaining = limits.cpuMs;
let sliceStart = 0;
let executing = false;
let interrupted = false;
let closed = false;
let requestSeq = 0;
let outputBytes = 0;
let requestBytes = 0;
const pending = new Map();
runtime.setInterruptHandler(() => {
  if (executing && performance.now() - sliceStart >= cpuRemaining) interrupted = true;
  return interrupted;
});

// Measure only interpreter work. Host promises (including human approval) consume no CPU budget.
function guest(fn) {
  if (executing) return fn();
  if (cpuRemaining <= 0) throw new Error("code computation limit exceeded");
  sliceStart = performance.now();
  executing = true;
  try {
    return fn();
  } finally {
    cpuRemaining -= performance.now() - sliceStart;
    executing = false;
  }
}
function stringify(handle) {
  return guest(() => {
    const json = vm.getProp(vm.global, "JSON");
    const fn = vm.getProp(json, "stringify");
    try {
      const value = guest(() => vm.unwrapResult(vm.callFunction(fn, json, handle)));
      try {
        return vm.typeof(value) === "undefined" ? "null" : vm.getString(value);
      } finally {
        value.dispose();
      }
    } finally {
      fn.dispose();
      json.dispose();
    }
  });
}
function decode(json) {
  // The host serialized a bounded JSON value. Parsing is guest computation too.
  return guest(() => vm.unwrapResult(vm.evalCode(`JSON.parse(${JSON.stringify(json)})`)));
}
function request(name, args) {
  if (closed) throw new Error("code invocation ended");
  if (pending.size >= limits.outstanding || ++requestSeq > limits.calls)
    throw new Error("code tool submission limit exceeded");
  const message = { type: "request", id: requestSeq, name, args };
  const bytes = Buffer.byteLength(JSON.stringify(message));
  if (bytes > limits.bridgeBytes || (requestBytes += bytes) > limits.totalBridgeBytes)
    throw new Error("code request data limit exceeded");
  const deferred = vm.newPromise();
  pending.set(requestSeq, { deferred });
  parentPort.postMessage(message);
  return deferred.handle;
}
function install(name, fn) {
  const handle = vm.newFunction(name, fn);
  vm.setProp(vm.global, name, handle);
  handle.dispose();
}
install("__call", (name, args) => {
  const raw = stringify(args);
  if (Buffer.byteLength(raw) > limits.bridgeBytes) throw new Error("code arguments limit exceeded");
  return request(vm.getString(name), JSON.parse(raw));
});
install("__emit", (value, isContent) => {
  const text = stringify(value);
  if ((outputBytes += Buffer.byteLength(text)) > limits.outputBytes)
    throw new Error("code output limit exceeded");
  parentPort.postMessage({
    type: "emit",
    content: vm.dump(isContent) ? JSON.parse(text) : [{ type: "text", text }],
  });
  return vm.undefined;
});
const setup = vm.evalCode(`
(() => {
const nativeCall = globalThis.__call;
const nativeEmit = globalThis.__emit;
delete globalThis.__call;
delete globalThis.__emit;
globalThis.tools = Object.freeze({
  call: async (name, args) => {
    const result = await nativeCall(String(name), args);
    if (result.status === "error") {
      const error = new Error(result.forModel.map(block => block.text).join(""));
      error.result = result; throw error;
    }
    return result.structured === undefined ? {
      content: result.forModel, status: result.status, full: result.full, annotations: result.annotations
    } : result.structured;
  }
});
globalThis.emit = value => nativeEmit(value, false);
globalThis.emitContent = blocks => nativeEmit(blocks, true);
})();
`);
vm.unwrapResult(setup).dispose();
let body;
function finish(value, error) {
  if (closed) return;
  closed = true;
  if (interrupted) {
    value = undefined;
    error = "code computation limit exceeded";
  }
  if (value !== undefined && outputBytes + Buffer.byteLength(value) > limits.outputBytes) {
    value = undefined;
    error = "code output limit exceeded";
  }
  parentPort.postMessage({
    type: "done",
    ...(value === undefined ? {} : { value }),
    ...(error === undefined ? {} : { error: String(error).slice(0, 2048) }),
  });
  for (const { deferred } of pending.values()) deferred.dispose();
  pending.clear();
  body?.dispose();
  vm.dispose();
  runtime.dispose();
  parentPort.close();
}
function fail(error) {
  finish(undefined, error instanceof Error ? error.message : String(error));
}
function pump() {
  if (closed) return;
  try {
    if (runtime.hasPendingJob()) {
      const jobs = guest(() => runtime.executePendingJobs(1));
      if (jobs.error) {
        let error;
        try {
          error = guest(() => vm.dump(jobs.error));
        } finally {
          jobs.error.dispose();
        }
        throw new Error(error?.message ?? String(error));
      }
    }
    const state = guest(() => vm.getPromiseState(body));
    if (state.type === "fulfilled") {
      let value;
      try {
        value = stringify(state.value);
      } finally {
        state.value.dispose();
      }
      finish(value);
      return;
    }
    if (state.type === "rejected") {
      let error;
      try {
        error = guest(() => vm.dump(state.error));
      } finally {
        state.error.dispose();
      }
      finish(undefined, error?.message ?? String(error));
      return;
    }
    if (runtime.hasPendingJob()) setImmediate(pump);
    else if (pending.size === 0)
      finish(undefined, "code body awaits a promise with no host operation");
  } catch (error) {
    fail(error);
  }
}
parentPort.on("message", (message) => {
  if (closed) return;
  const request = pending.get(message.id);
  if (!request) throw new Error("unknown code bridge response");
  pending.delete(message.id);
  try {
    try {
      const handle =
        message.error !== undefined ? vm.newError(message.error) : decode(message.value);
      try {
        guest(() => {
          if (message.error !== undefined) request.deferred.reject(handle);
          else request.deferred.resolve(handle);
        });
      } finally {
        handle.dispose();
      }
    } finally {
      request.deferred.dispose();
    }
  } catch (error) {
    fail(error);
    return;
  }
  pump();
});
try {
  body = guest(() => vm.unwrapResult(vm.evalCode(`(async () => {\n${code}\n})()`)));
  pump();
} catch (error) {
  fail(error);
}
