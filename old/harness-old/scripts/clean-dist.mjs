import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoots = ["apps", "packages"];

await rm(path.join(repoRoot, "dist"), { recursive: true, force: true });

for (const workspaceRoot of workspaceRoots) {
  const absoluteRoot = path.join(repoRoot, workspaceRoot);
  let entries = [];
  try {
    entries = await readdir(absoluteRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      continue;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    await rm(path.join(absoluteRoot, entry.name, "dist"), { recursive: true, force: true });
  }
}
