import type { Tool, ToolResult } from "@harness/protocol";

/** Echoes its JSON args back as the model-facing result. */
export class EchoTool implements Tool {
  readonly name = "echo";
  readonly schema = {
    name: "echo",
    description: "Echoes its arguments back.",
    parameters: { type: "object", additionalProperties: true },
  };

  execute(args: unknown): Promise<ToolResult> {
    return Promise.resolve({
      forModel: [{ type: "text", text: JSON.stringify(args) }],
      status: "ok",
    });
  }
}
