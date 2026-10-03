import { MemorySecretStore } from "@harness/secrets";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { authRegistry } from "./auth.ts";
import { LoginApp } from "./auth-app.tsx";

const noPersist = (): Promise<void> => Promise.resolve();
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("LoginApp", () => {
  it("completes an environment-only login with source guidance", async () => {
    const onResolve = vi.fn();
    const persist = vi.fn();
    const registry = authRegistry(new MemorySecretStore(), {
      providers: {
        work: { type: "openai-api", config: { apiKey: { env: "NAMED_CONNECTION_KEY" } } },
      },
    });
    const app = render(
      <LoginApp
        registry={registry}
        provider="work"
        onResolve={onResolve}
        onReject={() => {}}
        persist={persist}
      />,
    );
    await vi.waitFor(() =>
      expect(onResolve).toHaveBeenCalledWith("Set $NAMED_CONNECTION_KEY to configure work."),
    );
    expect(persist).not.toHaveBeenCalled();
    app.unmount();
  });
  it("shows the provider picker when no provider is preselected", () => {
    const { lastFrame } = render(
      <LoginApp
        registry={authRegistry(new MemorySecretStore())}
        onResolve={() => {}}
        onReject={(e) => {
          throw e;
        }}
        persist={noPersist}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Sign in to a provider");
    expect(frame).toContain("Anthropic");
    expect(frame).toContain("ChatGPT / Codex");
  });

  it("stores a pasted API key and resolves with a success line", async () => {
    const store = new MemorySecretStore();
    const onResolve = vi.fn();
    const { stdin } = render(
      <LoginApp
        registry={authRegistry(store)}
        provider="anthropic"
        onResolve={onResolve}
        onReject={(e) => {
          throw e;
        }}
        persist={noPersist}
      />,
    );

    await tick();
    stdin.write("sk-ant-secret");
    await tick();
    stdin.write("\r");

    await vi.waitFor(() => expect(onResolve).toHaveBeenCalled());
    expect(onResolve.mock.calls[0]?.[0]).toContain("anthropic/claude-opus-4-8");
    expect(await store.get("provider-instance:anthropic:api-key")).toBe("sk-ant-secret");
  });
});
