import { createElement as h, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Tooltip } from "radix-ui";
import { mockIPC } from "@tauri-apps/api/mocks";
import { connectionCommandSchema, defaultClientConfig } from "@harness/connections";
import { DesktopHosts } from "../../src/hosts.ts";
import { ConnectionEditor } from "../../src/connections-menu.tsx";

const config = defaultClientConfig();
config.hosts.push({
  id: "remote",
  label: "Workstation",
  kind: "ssh",
  destination: "dev@workstation",
});
const effects: string[] = [];
mockIPC((name, args) => {
  if (name !== "connection_command" || !args || !("command" in args))
    throw new Error(`Unexpected native call: ${name}`);
  const command = connectionCommandSchema.parse(args.command);
  switch (command.type) {
    case "wsl.list":
      effects.push("discover");
      return window.installedDistributions;
    case "config.read":
      break;
    case "host.save":
      effects.push(`save:${command.host.id}`);
      config.hosts = [...config.hosts.filter((host) => host.id !== command.host.id), command.host];
      break;
    case "host.select":
      effects.push(`select:${command.id}`);
      config.selectedHostId = command.id;
      break;
    case "host.remove":
      effects.push(`remove:${command.id}`);
      config.hosts = config.hosts.filter((host) => host.id !== command.id);
      break;
    default:
      throw new Error(`Unexpected connection command: ${command.type}`);
  }
  return structuredClone(config);
});
const hosts = new DesktopHosts();
hosts.connect = async (id, signal) => {
  effects.push(`connect:${id}`);
  if (window.stallConnection) {
    if (!signal) throw new Error("Expected a cancellable connection");
    await new Promise<never>((_, reject) => {
      signal.throwIfAborted();
      signal.addEventListener(
        "abort",
        () => reject(new Error(window.cancelConnectionError ?? "Connection attempt cancelled")),
        { once: true },
      );
    });
  }
  const view = hosts.views.get(id)!;
  view.identity = {
    managementVersion: 1,
    productVersion: "1.0.0",
    serverId: crypto.randomUUID(),
    instanceId: crypto.randomUUID(),
    protocolVersion: 1,
    home: "/home/dev",
    pid: 100,
    platform: "linux",
    buildId: "fixture",
  };
  hosts.changed();
  return view;
};
hosts.restart = async (id) => {
  effects.push(`restart:${id}`);
};
await hosts.initialize();
effects.length = 0;
declare global {
  interface Window {
    connectionEffects: string[];
    installedDistributions: string[];
    stallConnection?: boolean;
    cancelConnectionError?: string;
  }
}
window.connectionEffects = effects;
window.installedDistributions = [];
function Fixture() {
  const [open, setOpen] = useState(true);
  const trigger = useRef<HTMLButtonElement>(null);
  return h(
    "main",
    null,
    h(
      "button",
      { ref: trigger, onClick: () => setOpen(true) },
      `Manage connections: ${hosts.selected?.host.label}`,
    ),
    h(ConnectionEditor, { hosts, open, setOpen, returnFocusRef: trigger }),
  );
}
createRoot(document.getElementById("root")!).render(h(Tooltip.Provider, null, h(Fixture)));
