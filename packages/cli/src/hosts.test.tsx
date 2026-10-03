import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { canonicalHome, readDiscovery } from "@harness/connections/local";
import { stopServer } from "@harness/connections/node";
import { serverInfoRequest } from "@harness/connections";
import { TuiHosts } from "./hosts.ts";
import { HostApp } from "./host-app.tsx";

const launch = {
  executable: process.execPath,
  args: [
    "--conditions=development",
    "--import=tsx",
    resolve("packages/server/src/bin.ts"),
    "--background",
  ],
};
const roots: string[] = [];
const clients: TuiHosts[] = [];
async function home() {
  const path = await canonicalHome(join(tmpdir(), `harness-tui-${randomUUID()}`));
  roots.push(path);
  await writeFile(
    join(path, "settings.json"),
    JSON.stringify({ model: { provider: "demo", model: "demo-1" } }),
  );
  return path;
}
function manager() {
  const value = new TuiHosts({}, launch);
  clients.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const path of roots.splice(0)) {
    const owner = await readDiscovery(path);
    if (owner) await stopServer(owner);
    await rm(path, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

it("renders Local-first command center and saves an alias-only SSH route", async () => {
  const path = await home();
  vi.stubEnv("HARNESS_HOME", path);
  vi.stubEnv("HARNESS_CLIENT_HOME", path);
  const hosts = manager();
  await hosts.initialize();
  expect(hosts.config?.hosts.map((host) => host.kind)).toEqual(["local"]);
  const ui = render(<HostApp hosts={hosts} />);
  try {
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("/hosts"), { timeout: 20000 });
    await vi.waitFor(() => expect(hosts.selected?.presentation.activeId).toBeDefined(), {
      timeout: 20000,
    });
    ui.stdin.write("\u0007");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Add SSH"));
    // The Select menu's fourth entry is Add SSH.
    for (let index = 0; index < 3; index++) ui.stdin.write("\u001b[B");
    ui.stdin.write("\r");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Edit SSH connection"));
    let step = 0;
    for (const [field, text, initial] of [
      ["label", "Workstation", "SSH"],
      ["destination", "workstation", ""],
      ["source", "managed", "managed"],
      ["node", "", ""],
      ["directory", "", ""],
      ["home", "", ""],
    ] as const) {
      step++;
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toMatch(new RegExp(`Edit SSH connection.*${step}/6`));
        expect(ui.lastFrame()).toContain(field === "source" ? "Runtime source" : field);
      });
      if (initial !== text) {
        for (let index = 0; index < initial.length; index++) ui.stdin.write("\u007f");
        if (text) {
          ui.stdin.write(text);
          await vi.waitFor(() => expect(ui.lastFrame()).toContain(text));
        }
      }
      ui.stdin.write("\r");
    }
    await vi.waitFor(() =>
      expect(hosts.config?.hosts[1]).toMatchObject({
        kind: "ssh",
        label: "Workstation",
        destination: "workstation",
      }),
    );
    expect(hosts.config?.hosts[1]).not.toHaveProperty("port");
    expect(hosts.config?.hosts[1]).not.toHaveProperty("identityFile");
    expect(hosts.config?.selectedHostId).toBe("local");
    // Repeatedly unmount the conversation's nested Static output, then edit again.
    for (let iteration = 0; iteration < 3; iteration++) {
      ui.stdin.write("\u0007");
      await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("Agent command center"));
      await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("Connecting"));
      ui.stdin.write("\u0007");
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("Add SSH"));
    }
  } finally {
    ui.unmount();
  }
}, 30000);

it("reconnects to the same background owner and drops presentation when Local is redirected", async () => {
  const firstHome = await home();
  const secondHome = await home();
  vi.stubEnv("HARNESS_HOME", firstHome);
  vi.stubEnv("HARNESS_CLIENT_HOME", firstHome);
  const hosts = manager();
  await hosts.initialize();
  const first = await hosts.connect("local");
  const identity = first.identity!;
  const conversation = await first.harness!.service.createConversation({ cwd: firstHome });
  hosts.setActive("local", conversation.id);
  first.presentation.drafts.set(conversation.id, "unsent text");
  await hosts.disconnect("local");
  const fresh = await hosts.connect("local");
  expect(fresh.identity).toEqual(identity);
  expect(fresh.presentation.activeId).toBe(conversation.id);
  expect(fresh.presentation.drafts.get(conversation.id)).toBe("unsent text");
  const second = manager();
  await second.initialize();
  await second.connect("local");
  await hosts.close();
  await expect(hosts.connect("local")).rejects.toThrow("shutting down");
  await expect(hosts.refresh("local")).rejects.toThrow("shutting down");
  expect(await second.selected!.harness!.client.peer.request(serverInfoRequest, {})).toEqual(
    identity,
  );
  await second.edit({
    type: "host.save",
    host: { id: "local", kind: "local", label: "Local", home: secondHome },
  });
  const redirected = await second.connect("local");
  expect(redirected.identity!.serverId).not.toBe(identity.serverId);
  expect(redirected.presentation.activeId).toBeUndefined();
  expect(redirected.presentation.drafts.size).toBe(0);
}, 30000);
