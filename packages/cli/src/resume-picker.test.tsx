import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { Conversation } from "@harness/protocol";
import { ResumePicker } from "./resume-picker.tsx";

const conv = (id: string, model: string, workspaceRoot: string | null = null): Conversation =>
  ({
    id,
    workspaceRoot,
    overrides: {},
    config: { instructions: "", model: { provider: "x", model } },
    head: null,
    createdAt: Date.now(),
  }) as unknown as Conversation;

describe("ResumePicker", () => {
  it("lists conversations with a short id, workspace, and model", () => {
    const { lastFrame } = render(
      <ResumePicker
        conversations={[
          conv("abcdefgh-1111", "gpt-x", "/home/me/proj"),
          conv("zzzzzzzz-2222", "claude-y", null),
        ]}
        showingAll={false}
        onSelect={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("abcdefgh");
    expect(frame).toContain("gpt-x");
    expect(frame).toContain("proj"); // workspace basename
    expect(frame).toContain("no workspace"); // projectless
  });
});
