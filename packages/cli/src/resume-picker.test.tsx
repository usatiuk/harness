import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { Conversation } from "@harness/protocol";
import { ResumePicker } from "./resume-picker.tsx";

const conv = (id: string, model: string): Conversation =>
  ({
    id,
    config: { instructions: "", model: { provider: "x", model } },
    head: null,
    createdAt: Date.now(),
  }) as unknown as Conversation;

describe("ResumePicker", () => {
  it("lists conversations with a short id and model", () => {
    const { lastFrame } = render(
      <ResumePicker
        conversations={[conv("abcdefgh-1111", "gpt-x"), conv("zzzzzzzz-2222", "claude-y")]}
        onSelect={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("abcdefgh");
    expect(frame).toContain("gpt-x");
  });
});
