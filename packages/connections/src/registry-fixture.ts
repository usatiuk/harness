import { saveHost } from "./registry.ts";
const [path, id] = process.argv.slice(2);
if (path === undefined || id === undefined)
  throw new Error("Registry fixture requires path and ID");
await saveHost(
  {
    kind: "ssh",
    id,
    label: id,
    destination: id,

    runtime: { source: "development" },
  },
  path,
);
