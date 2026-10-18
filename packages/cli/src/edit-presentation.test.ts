import { describe, expect, it } from "vitest";
import type { Cell } from "./transcript-reducer.ts";
import { editPresentation } from "./edit-presentation.ts";

const tool = (name: string, args: unknown): Extract<Cell, { kind: "tool" }> => ({
  kind: "tool",
  callId: "call-1",
  turnId: "turn-1",
  name,
  args,
  startedAt: 0,
  completedAt: 1,
  status: "ok",
  output: "done",
});

describe("editPresentation", () => {
  it("parses a multi-file apply_patch into colored semantic lines", () => {
    const edit = editPresentation(
      tool(
        "apply_patch",
        [
          "*** Begin Patch",
          "*** Update File: a.ts",
          "@@",
          "-old",
          "+new",
          "*** Add File: b.ts",
          "+created",
          "*** End Patch",
        ].join("\n"),
      ),
    );
    expect(edit).toMatchObject({
      labels: {
        running: "Updating 2 files",
        succeeded: "Updated 2 files",
        failed: "Failed to update 2 files",
      },
      files: [
        {
          path: "a.ts",
          lines: [
            { kind: "hunk", text: "@@" },
            { kind: "remove", text: "-old" },
            { kind: "add", text: "+new" },
          ],
        },
        { path: "b.ts", lines: [{ kind: "add", text: "+created" }] },
      ],
    });
  });

  it("renders structured replacements", () => {
    expect(
      editPresentation(tool("edit", { path: "a.ts", old_string: "old", new_string: "new" })),
    ).toMatchObject({
      labels: { running: "Editing a.ts", succeeded: "Edited a.ts", failed: "Failed to edit a.ts" },
      files: [
        {
          lines: [
            { kind: "remove", text: "-old" },
            { kind: "add", text: "+new" },
          ],
        },
      ],
    });
  });

  it("leaves malformed patches and unknown tools to the generic renderer", () => {
    expect(editPresentation(tool("apply_patch", "not a patch"))).toBeUndefined();
    expect(editPresentation(tool("plugin_tool", {}))).toBeUndefined();
  });
});

it("renders JSON-wrapped and historical raw patches identically", () => {
  const patch =
    "sandbox_permissions=require_escalated\njustification=approved edit\n---\n*** Begin Patch\n*** Add File: new.ts\n+export const value = 1;\n*** End Patch";
  expect(editPresentation(tool("apply_patch", { patch }))).toEqual(
    editPresentation(tool("apply_patch", patch)),
  );
  expect(editPresentation(tool("apply_patch", { patch }))?.files[0]?.path).toBe("new.ts");
});
