import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Terminal } from "lucide-react";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";

const icons = resolve("src-tauri/icons");
const output = resolve("src-tauri/target/generated-icons");
const mark = renderToStaticMarkup(
  createElement(Terminal, { x: 40, y: 40, width: 176, height: 176, color: "white" }),
);
await writeFile(
  resolve(icons, "source.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="48" fill="#2563eb"/>${mark}</svg>\n`,
);
await mkdir(output, { recursive: true });
const cli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
const result = spawnSync(
  process.execPath,
  [cli, "icon", resolve(icons, "source.svg"), "-o", output],
  {
    stdio: "inherit",
    windowsHide: true,
  },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Icon generation failed: ${result.status}`);
// Keep only the desktop formats already shipped by this application.
for (const name of [
  "icon.png",
  "icon.ico",
  "icon.icns",
  "32x32.png",
  "64x64.png",
  "128x128.png",
  "128x128@2x.png",
]) {
  await copyFile(resolve(output, name), resolve(icons, name));
}
