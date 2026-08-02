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

  it("renders structured replacement and insertion operations", () => {
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
    expect(
      editPresentation(
        tool("str_replace_based_edit_tool", {
          command: "insert",
          path: "a.ts",
          insert_line: 3,
          new_str: "new",
        }),
      ),
    ).toMatchObject({
      labels: {
        running: "Inserting into a.ts",
        succeeded: "Inserted into a.ts",
        failed: "Failed to insert into a.ts",
      },
      files: [
        {
          lines: [
            { kind: "hunk", text: "@@ after line 3" },
            { kind: "add", text: "+new" },
          ],
        },
      ],
    });
  });

  it("leaves views, malformed patches, and unknown tools to the generic renderer", () => {
    expect(
      editPresentation(tool("str_replace_based_edit_tool", { command: "view", path: "README.md" })),
    ).toBeUndefined();
    expect(editPresentation(tool("apply_patch", "not a patch"))).toBeUndefined();
    expect(editPresentation(tool("plugin_tool", {}))).toBeUndefined();
  });
});
