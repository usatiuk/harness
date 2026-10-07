import { randomUUID } from "node:crypto";
import { writeFile, rm, readFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { deviceAuthFixture } from "@harness/testkit";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { act, useEffect, useState } from "react";
import { Select } from "@inkjs/ui";
import { Text } from "ink";
import { canonicalHome, readDiscovery } from "@harness/connections/local";
import { stopServer } from "@harness/connections/node";
import { serverInfoRequest } from "@harness/connections";
import { TuiHosts } from "./hosts.ts";
import { HostApp } from "./host-app.tsx";

async function writeInput(ui: ReturnType<typeof render>, text: string): Promise<void> {
  // Flush React's effects before sending the next key to a newly mounted input.
  await act(async () => {});
  await act(async () => {
    ui.stdin.write(text);
  });
}

it("retains the first navigation key after an asynchronous provider menu appears", async () => {
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  const selected: string[] = [];
  function Menu() {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      void loaded.then(() => setReady(true));
    }, []);
    return ready ? (
      <Select
        options={["OpenAI", "Anthropic", "OpenCode", "Codex"].map((label) => ({
          label,
          value: label,
        }))}
        onChange={(value) => selected.push(value)}
      />
    ) : (
      <Text>Loading providers</Text>
    );
  }
  const ui = render(<Menu />);
  let visible!: () => void;
  const frame = new Promise<void>((resolve) => {
    visible = resolve;
  });
  const write = ui.stdout.write;
  ui.stdout.write = (text) => {
    write(text);
    if (text.includes("Codex")) visible();
  };
  try {
    release();
    await frame;
    for (const label of ["Anthropic", "OpenCode", "Codex"]) {
      await writeInput(ui, "\u001b[B");
      expect(ui.lastFrame()).toMatch(new RegExp(`[>❯].*${label}`));
    }
    await writeInput(ui, "\r");
    expect(selected).toEqual(["Codex"]);
  } finally {
    ui.unmount();
  }
});

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
  const hosts = manager();
  await hosts.initialize();
  expect(hosts.config?.hosts.map((host) => host.kind)).toEqual(["local"]);
  const ui = render(<HostApp hosts={hosts} />);
  try {
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("/hosts"), { timeout: 20000 });
    await vi.waitFor(() => expect(hosts.selected?.presentation.activeId).toBeDefined(), {
      timeout: 20000,
    });
    await writeInput(ui, "\u0007");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Add SSH"));
    // The Select menu's fourth entry is Add SSH.
    for (let index = 0; index < 3; index++) await writeInput(ui, "\u001b[B");
    await writeInput(ui, "\r");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Edit SSH connection"));
    let step = 0;
    for (const [field, text, initial] of [
      ["label", "Workstation", "SSH"],
      ["destination", "workstation", ""],
      ["source", "managed", "managed"],
    ] as const) {
      step++;
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toMatch(new RegExp(`Edit SSH connection.*${step}/3`));
        expect(ui.lastFrame()).toContain(field === "source" ? "Runtime source" : field);
      });
      if (initial !== text) {
        for (let index = 0; index < initial.length; index++) await writeInput(ui, "\u007f");
        if (text) {
          await writeInput(ui, text);
          await vi.waitFor(() => expect(ui.lastFrame()).toContain(text));
        }
      }
      await writeInput(ui, "\r");
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
      await writeInput(ui, "\u0007");
      await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("Agent command center"));
      await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("Connecting"));
      await writeInput(ui, "\u0007");
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("Add SSH"));
    }
  } finally {
    ui.unmount();
  }
}, 30000);

it("reconnects to the same background owner and preserves drafts and another client", async () => {
  const firstHome = await home();
  const workspace = join(firstHome, "workspace");
  // Bound project discovery so this fixture cannot inherit the developer's settings.
  await mkdir(join(workspace, ".harness"), { recursive: true });
  vi.stubEnv("HARNESS_HOME", firstHome);
  const hosts = manager();
  try {
    await hosts.initialize();
    const first = await hosts.connect("local");
    const identity = first.identity!;
    const conversation = await first.harness!.service.createConversation({ cwd: workspace });
    hosts.setActive("local", conversation.id);
    first.presentation.drafts.set(conversation.id, "unsent text");
    await hosts.edit({ type: "host.save", host: { ...first.host, label: "My computer" } });
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
  } catch (error) {
    throw new Error(await readFile(join(firstHome, ".server", "startup.log"), "utf8"), {
      cause: error,
    });
  }
}, 30000);

it("renders both Local OAuth methods, displays a device code and cancels when leaving sign-in", async () => {
  const path = await home();
  vi.stubEnv("HARNESS_HOME", path);
  vi.stubEnv("LOCALAPPDATA", join(path, "credentials"));
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY"])
    vi.stubEnv(name, "");
  const network = await deviceAuthFixture(path);
  const hosts = new TuiHosts(
    {},
    { ...launch, env: { NODE_OPTIONS: `--import=${pathToFileURL(network.preload).href}` } },
  );
  clients.push(hosts);
  await hosts.initialize();
  const ui = render(<HostApp hosts={hosts} />);
  const openAuth = async () => {
    await writeInput(ui, "\u0007");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Select host"));
    for (let i = 0; i < 6; i++) await writeInput(ui, "\u001b[B");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Provider sign-in"));
    await writeInput(ui, "\r");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("ChatGPT / Codex"));
    for (const label of ["Anthropic", "OpenCode Go", "ChatGPT / Codex"]) {
      await writeInput(ui, "\u001b[B");
      await vi.waitFor(() => expect(ui.lastFrame()).toMatch(new RegExp(`[>❯].*${label}`)));
    }
    await writeInput(ui, "\r");
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain("Browser sign-in");
      expect(ui.lastFrame()).toContain("Device code");
    });
    await writeInput(ui, "\u001b[B");
    await writeInput(ui, "\r");
  };
  try {
    await vi.waitFor(() => expect(hosts.selected?.presentation.activeId).toBeDefined(), {
      timeout: 20000,
    });
    await openAuth();
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Code: FIXTURE-CODE"));
    expect(ui.lastFrame()).toContain("https://auth.openai.com/codex/device");
    await vi.waitFor(async () => expect(await readFile(network.polling, "utf8")).toBe("polling"));
    await writeInput(ui, "\u001b");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Select host"));
    await vi.waitFor(async () =>
      expect(await readFile(network.cancelled, "utf8")).toBe("cancelled"),
    );
    expect(ui.lastFrame()).not.toContain("FIXTURE-CODE");
    await writeInput(ui, "\u0007");
    await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("Agent command center"));
    await writeFile(network.allow, "yes");
    await openAuth();
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Signed in; restart this host"));
    expect(ui.lastFrame()).not.toContain(network.refreshToken);
  } finally {
    ui.unmount();
  }
}, 30000);
