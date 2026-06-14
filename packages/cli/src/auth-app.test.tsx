import { MemorySecretStore } from "@harness/secrets";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { authRegistry } from "./auth.ts";
import { LoginApp } from "./auth-app.tsx";

const noPersist = (): Promise<void> => Promise.resolve();
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("LoginApp", () => {
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
    expect(await store.get("apikey:anthropic")).toBe("sk-ant-secret");
  });
});
