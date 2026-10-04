import { act } from "react";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultHome } from "@harness/config";
import {
  readDiscovery,
  discoverySchema,
  stopServer,
  stopRemoteServer,
  runRemote,
  shellQuote,
} from "@harness/connections/node";
import type { Host } from "@harness/connections";
import { TuiHosts } from "./hosts.ts";
import { HostApp } from "./host-app.tsx";

it.skipIf(!process.env.HARNESS_REMOTE_WSL || !process.env.HARNESS_REMOTE_FIXTURE_HOME)(
  "uses a real WSL conversation through TUI host selection, close and fresh attachment",
  async () => {
    const root = process.env.HARNESS_REMOTE_FIXTURE_HOME!;
    const home = defaultHome();
    const remote: Host & { kind: "wsl" } = {
      id: "wsl-tui",
      label: "WSL TUI",
      kind: "wsl",
      distribution: process.env.HARNESS_REMOTE_WSL!,
      user: null,
      runtime: { source: "managed" },
    };
    const q = shellQuote;
    const settings = JSON.stringify({ model: { provider: "demo", model: "demo-1" } });
    await runRemote(
      remote,
      `umask 077; mkdir -p ${q(`${root}/.harness`)} ${q(`${root}/project`)}; printf '%s' ${q(settings)} > ${q(`${root}/.harness/settings.json`)}`,
    );
    await writeFile(join(home, "settings.json"), settings);
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY"])
      vi.stubEnv(name, "");
    vi.stubEnv("LOCALAPPDATA", join(home, "local-appdata"));
    const launch = {
      executable: process.execPath,
      args: [
        "--conditions=development",
        "--import=tsx",
        resolve("packages/server/src/bin.ts"),
        "--background",
      ],
    };
    const hosts = new TuiHosts({}, launch);
    let fresh: TuiHosts | undefined;
    let ui: ReturnType<typeof render> | undefined;
    const input = async (text: string) => {
      await act(async () => {
        ui!.stdin.write(text);
      });
    };
    try {
      await hosts.initialize();
      await hosts.edit({ type: "host.save", host: remote });
      hosts.newConversation(remote.id, `${root}/project`);
      ui = render(<HostApp hosts={hosts} />);
      await vi.waitFor(() => expect(hosts.selected?.presentation.activeId).toBeDefined(), {
        timeout: 20_000,
      });
      const localId = hosts.selected!.presentation.activeId;
      await input("\u0007");
      await vi.waitFor(() => expect(ui!.lastFrame()).toContain("Select host"));
      await input("\r");
      await vi.waitFor(() => expect(ui!.lastFrame()).toContain("WSL TUI · disconnected"));
      await input("\u001b[B");
      await input("\r");
      await vi.waitFor(() => expect(hosts.selected?.host.id).toBe(remote.id));
      await vi.waitFor(() => expect(ui!.lastFrame()).toContain("type a message"), {
        timeout: 60_000,
      });
      const remoteView = hosts.selected!;
      const conversationId = remoteView.presentation.activeId!;
      const identity = remoteView.identity!;
      await input("tui-remote-marker");
      await vi.waitFor(() => expect(ui!.lastFrame()).toContain("tui-remote-marker"));
      await input("\r");
      await vi.waitFor(() => expect(ui!.lastFrame()).toContain("approve bash?"), {
        timeout: 10_000,
      });
      await input("\u0007");
      await vi.waitFor(() => expect(ui!.lastFrame()).toContain("Select host"));
      await input("\r");
      await vi.waitFor(() => expect(ui!.lastFrame()).toContain("Local · connected"));
      await input("\r");
      await vi.waitFor(() => expect(ui!.lastFrame()).toContain("Host: Local"));
      expect(hosts.selected!.presentation.activeId).toBe(localId);
      expect(remoteView.harness!.client.peer.ready).toBe(true);
      ui.unmount();
      ui = undefined;
      await hosts.close();
      fresh = new TuiHosts({}, launch);
      await fresh.initialize(undefined, remote.id);
      ui = render(<HostApp hosts={fresh} options={{ conversationId }} />);
      await vi.waitFor(() => expect(ui!.lastFrame()).toContain("approve bash?"), {
        timeout: 60_000,
      });
      expect(fresh.selected!.identity).toEqual(identity);
      await input("y");
      await vi.waitFor(() => expect(ui!.lastFrame()).toContain("Done"), { timeout: 10_000 });
      await vi.waitFor(() => expect(ui!.lastFrame()).not.toContain("Working…"));
      expect(ui.lastFrame()).toContain("tui-remote-marker");
      await fresh.stop(remote.id);
    } finally {
      ui?.unmount();
      await fresh?.close();
      await hosts.close();
      const local = await readDiscovery(home);
      if (local) await stopServer(local);
      const discovery = discoverySchema
        .nullable()
        .parse(
          JSON.parse(
            await runRemote(
              remote,
              `if test -f ${q(`${root}/.harness/.server/discovery.json`)}; then cat ${q(`${root}/.harness/.server/discovery.json`)}; else printf null; fi`,
            ),
          ),
        );
      if (discovery) {
        const runtime = fresh?.views.get(remote.id)?.runtime ?? hosts.views.get(remote.id)?.runtime;
        assert(runtime, "Remote fixture owner exists without its prepared runtime");
        await stopRemoteServer(remote, runtime, discovery);
        await vi.waitFor(
          async () =>
            expect(
              await runRemote(
                remote,
                `if kill -0 ${discovery.pid} 2>/dev/null; then printf running; else printf stopped; fi`,
              ),
            ).toBe("stopped"),
          { timeout: 20_000 },
        );
      }
      await runRemote(remote, `rm -rf ${q(root)}`);
      vi.unstubAllEnvs();
    }
  },
  120_000,
);
