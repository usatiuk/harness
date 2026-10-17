import { expect, it } from "vitest";
import { workspaceSelectionSchema } from "./client-protocol.ts";

it("accepts optional branch names only when creating a worktree", () => {
  expect(workspaceSelectionSchema.parse({ kind: "new", branch: "feature/auth" })).toEqual({
    kind: "new",
    branch: "feature/auth",
  });
  expect(workspaceSelectionSchema.parse({ kind: "new" })).toEqual({ kind: "new" });
  for (const input of [
    { kind: "original", branch: "feature/auth" },
    { kind: "existing", path: "/checkout", branch: "feature/auth" },
    { kind: "new", branch: "" },
  ])
    expect(workspaceSelectionSchema.safeParse(input).success).toBe(false);
});
