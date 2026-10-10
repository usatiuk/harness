import { expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { act } from "react";
import type { HarnessClient } from "@harness/client";
import { mcpConfigSchema } from "@harness/mcp/client";
import { McpSettings } from "./mcp-settings.tsx";
import type { TuiHostView } from "./hosts.ts";

it("renders MCP host settings, saves structured config, and masks credential input", async () => {
  const config = mcpConfigSchema.parse({
    servers: {
      local: {
        transport: {
          type: "stdio",
          executable: "fixture",
          env: { KEY: { type: "secret", slot: "api-key" } },
        },
      },
      hosted: {
        transport: { type: "http", url: "https://example.com/mcp", auth: { type: "oauth" } },
      },
    },
  });
  const calls: { method: string; params: unknown }[] = [];
  const client = {
    peer: {
      request: async (definition: { method: string }, params: unknown) => {
        calls.push({ method: definition.method, params });
        if (definition.method === "plugin.mcp.settings.get")
          return {
            config,
            credentialBackend: "file",
            restartRequired: false,
            active: [
              {
                id: "local",
                status: "disabled",
                detail: null,
                toolCount: 0,
                authenticated: false,
                signingIn: false,
                credentials: [],
              },
            ],
          };
        return null;
      },
    },
  } as unknown as HarnessClient;
  const view = {
    host: { id: "local", kind: "local", label: "Local" },
    harness: { client },
  } as TuiHostView;
  const error = vi.fn();
  const ui = render(<McpSettings view={view} onError={error} />);
  const input = async (text: string) => {
    await act(async () => {});
    await act(async () => {
      ui.stdin.write(text);
    });
  };
  try {
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Edit MCP configuration"));
    await input("\r");
    expect(ui.lastFrame()).toContain("ask-human");
    expect(ui.lastFrame()?.replaceAll("\n", "")).toContain("https://example.com/mcp");
    await input("\r");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Saved. Restart"));
    expect(calls.find((call) => call.method === "plugin.mcp.settings.set")?.params).toEqual({
      config,
    });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Edit MCP configuration"));
    await input("\u001b[B");
    await input("\r");
    await input("\r");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Replace stored credential"));
    await input("\u001b[B");
    await input("\r");
    await input("api-key");
    await input("\r");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Credential for local/api-key"));
    await input("private-value");
    expect(ui.lastFrame()).not.toContain("private-value");
    await input("\r");
    await vi.waitFor(() =>
      expect(calls).toContainEqual({
        method: "plugin.mcp.credentials.set",
        params: { serverId: "local", slot: "api-key", value: "private-value" },
      }),
    );
    expect(ui.lastFrame()).not.toContain("private-value");
    expect(error).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
  }
});

it.each(["leave", "refresh"] as const)(
  "completes OAuth and cancels an owned attempt on %s",
  async (mode) => {
    let config = mcpConfigSchema.parse({
      servers: {
        hosted: {
          transport: { type: "http", url: "https://example.com/mcp", auth: { type: "oauth" } },
        },
      },
    });
    const calls: { method: string; params: unknown }[] = [];
    let signingIn = false;
    const client = {
      peer: {
        request: async (definition: { method: string }, params: unknown) => {
          calls.push({ method: definition.method, params });
          if (definition.method === "plugin.mcp.settings.get")
            return {
              config,
              credentialBackend: "file",
              restartRequired: false,
              active: Object.keys(config.servers).map((id) => ({
                id,
                status: "auth-required",
                detail: null,
                toolCount: 0,
                authenticated: false,
                signingIn: id === "hosted" ? signingIn : true,
                credentials: [],
              })),
            };
          if (definition.method === "plugin.mcp.auth.start") {
            signingIn = true;
            return {
              attemptId: "one",
              url: "https://example.com/authorize?state=one",
              redirectUrl: "http://127.0.0.1:4321/auth/callback",
            };
          }
          if (
            definition.method === "plugin.mcp.auth.complete" ||
            definition.method === "plugin.mcp.auth.cancel"
          )
            signingIn = false;
          return null;
        },
      },
    } as unknown as HarnessClient;
    const view = {
      host: { id: "remote", kind: "ssh", label: "Remote" },
      harness: { client },
    } as TuiHostView;
    const error = vi.fn();
    const ui = render(<McpSettings view={view} onError={error} />);
    const input = async (text: string) => {
      await act(async () => {});
      await act(async () => {
        ui.stdin.write(text);
      });
    };
    const login = async () => {
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("OAuth sign-in"));
      for (let i = 0; i < 3; i++) await input("\u001b[B");
      await input("\r");
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("Paste the full redirected URL"));
    };
    try {
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("Edit MCP configuration"));
      await input("\u001b[B");
      await input("\r");
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("hosted"));
      await input("\r");
      await login();
      const callbackUrl = "http://127.0.0.1:4321/auth/callback?state=one&code=code";
      await input(callbackUrl);
      await input("\r");
      await vi.waitFor(() =>
        expect(calls).toContainEqual({
          method: "plugin.mcp.auth.complete",
          params: { attemptId: "one", callbackUrl },
        }),
      );
      await login();
      if (mode === "leave") ui.unmount();
      else {
        config = mcpConfigSchema.parse({
          servers: {
            other: {
              transport: {
                type: "http",
                url: "https://other.example/mcp",
                auth: { type: "oauth" },
              },
            },
          },
        });
        await input("\r");
      }
      await vi.waitFor(() =>
        expect(calls).toContainEqual({
          method: "plugin.mcp.auth.cancel",
          params: { attemptId: "one" },
        }),
      );
      expect(error).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
    }
  },
);
