import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, chmod, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { DpapiSecretStore, FileSecretStore } from "@harness/secrets";
import { serverIdentitySchema } from "./contracts.ts";
import { z } from "zod";

export const discoverySchema = serverIdentitySchema.extend({
  port: z.number().int().min(1).max(65535),
});
export type ServerDiscovery = z.infer<typeof discoverySchema>;
export const sameHome = (left: string, right: string): boolean =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
const exec = promisify(execFile);

export async function canonicalHome(home: string): Promise<string> {
  const absolute = resolve(home);
  if (process.platform !== "win32") await mkdir(absolute, { recursive: true, mode: 0o700 });
  await protectDirectory(absolute, false);
  const canonical = await realpath(absolute);
  if (!sameHome(absolute, canonical)) await protectDirectory(canonical, false);
  return canonical;
}

/** Protect both endpoint integrity and secret confidentiality at the OS-user boundary. */
export async function privateRuntimeDirectory(home: string): Promise<string> {
  const directory = join(home, ".server");
  if (process.platform !== "win32") await mkdir(directory, { recursive: true, mode: 0o700 });
  await protectDirectory(directory, true);
  return directory;
}

async function protectDirectory(directory: string, setPrivate: boolean): Promise<void> {
  if (process.platform === "win32") {
    // Use .NET directly: inherited PowerShell 7 module paths can break the
    // Windows PowerShell security cmdlets in a Node-launched subprocess.
    const script = `$ErrorActionPreference = 'Stop'; $path = '${directory.replaceAll("'", "''")}';
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$private = [System.Security.AccessControl.DirectorySecurity]::new();
$private.SetOwner($user);
$private.SetAccessRuleProtection($true, $false);
$private.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'));
# This overload applies the ACL at creation, including simultaneous first starts.
[void][System.IO.Directory]::CreateDirectory($path, $private);
$acl = [System.IO.Directory]::GetAccessControl($path);
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { exit 77 };
if (${setPrivate ? "$true" : "$false"}) {
[System.IO.Directory]::SetAccessControl($path, $private);
} else {
$trusted = @($user.Value, 'S-1-5-18', 'S-1-5-32-544');
$mutation = [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership;
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $trusted -notcontains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band $mutation) -ne 0) { exit 78 }
}
}`;
    try {
      await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { windowsHide: true },
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 77) throw new Error("Harness directory has another owner", { cause: error });
      if (code === 78)
        throw new Error("Harness home is writable by other users; choose a user-private home", {
          cause: error,
        });
      throw error;
    }
  } else {
    const info = await stat(directory);
    if (info.uid !== process.getuid?.())
      throw new Error("Server discovery directory has another owner");
    if (setPrivate) await chmod(directory, 0o700);
    else if ((info.mode & 0o022) !== 0)
      throw new Error("Harness home is writable by other users; choose a user-private home");
  }
}

export function serverSecretStore(directory: string) {
  return process.platform === "win32"
    ? new DpapiSecretStore(join(directory, "auth.dpapi"))
    : new FileSecretStore(join(directory, "auth.json"));
}

export async function readDiscovery(home: string): Promise<ServerDiscovery | null> {
  try {
    return discoverySchema.parse(
      JSON.parse(await readFile(join(home, ".server", "discovery.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export const createServerToken = (): string => randomBytes(32).toString("hex");

/** A tiny bounded preamble authenticates before a socket is admitted to RPC. */
export async function authenticateSocket(socket: Socket, sendToken?: string): Promise<string> {
  socket.setTimeout(0);
  const timeout = setTimeout(
    () => socket.destroy(new Error("Server authentication timed out")),
    5000,
  );
  try {
    const line = await new Promise<string>((resolveLine, reject) => {
      let bytes = Buffer.alloc(0);
      const finish = (error?: Error, value?: string) => {
        socket.off("data", data);
        socket.off("error", fail);
        socket.off("close", closed);
        if (error !== undefined) reject(error);
        else resolveLine(value!);
      };
      const fail = (error: Error) => finish(error);
      const closed = () => finish(new Error("Server closed during authentication"));
      const data = (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        const newline = bytes.indexOf(0x0a);
        if ((newline < 0 ? bytes.byteLength : newline) > (sendToken === undefined ? 128 : 4096)) {
          finish(new Error("Invalid authentication preamble"));
          socket.destroy();
          return;
        }
        if (newline < 0) return;
        socket.pause();
        const rest = bytes.subarray(newline + 1);
        finish(undefined, bytes.subarray(0, newline).toString("utf8"));
        if (rest.byteLength > 0) socket.unshift(rest);
      };
      socket.on("data", data);
      socket.once("error", fail);
      socket.once("close", closed);
      socket.resume();
      if (sendToken !== undefined) socket.write(`${sendToken}\n`);
    });
    return line;
  } finally {
    clearTimeout(timeout);
  }
}

export async function connectDiscovered(
  home: string,
  discovery: ServerDiscovery,
  signal?: AbortSignal,
): Promise<{ socket: Socket; identity: z.infer<typeof serverIdentitySchema> }> {
  if (!sameHome(home, discovery.home))
    throw new Error(
      "Server discovery belongs to another Harness home; remove the copied discovery record before connecting",
    );
  signal?.throwIfAborted();
  const token = await serverSecretStore(join(home, ".server")).get("token");
  if (token === null) throw new Error("Server authentication secret is missing");
  signal?.throwIfAborted();
  const socket = createConnection({ host: "127.0.0.1", port: discovery.port });
  const cancel = () => socket.destroy(new Error("Server connection cancelled"));
  signal?.addEventListener("abort", cancel, { once: true });
  socket.setTimeout(3000, () => socket.destroy(new Error("Server connection timed out")));
  try {
    await once(socket, "connect");
    signal?.throwIfAborted();
    const identity = serverIdentitySchema.parse(
      JSON.parse(await authenticateSocket(socket, token)),
    );
    if (
      !sameHome(home, identity.home) ||
      identity.serverId !== discovery.serverId ||
      identity.instanceId !== discovery.instanceId
    )
      throw new Error("Server identity does not match this Harness home and discovery record");
    return { socket, identity };
  } catch (error) {
    socket.destroy();
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
