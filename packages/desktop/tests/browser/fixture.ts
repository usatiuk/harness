import { createElement as h, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Tooltip } from "radix-ui";
import Markdown from "react-markdown";
import type { Cell } from "@harness/client-features/transcript-reducer";
import { ConversationCanvas } from "../../src/components/conversation-canvas.tsx";
import { DesktopTranscript, type TranscriptRow } from "../../src/transcript.ts";
import { Button, Disclosure } from "../../src/ui.tsx";
import { DesktopUpdates } from "../../src/components/desktop-updates.tsx";
import "../../src/styles.css";

declare global {
  interface Window {
    canvasFixture: {
      ready: boolean;
      grow(): void;
      prepend(): void;
      setRunning(value: boolean): void;
      setSupport(value: boolean): void;
      start(): void;
      appendAssistant(text?: string): void;
      appendTool(): void;
    };
  }
}

const user = (index: number): Cell => ({
  kind: "user",
  id: `user${index}`,
  turnId: "turn",
  text: `History ${index}: representative discussion`,
  createdAt: index,
});
const child: Cell = {
  kind: "tool",
  callId: "child",
  parentCallId: "parent",
  name: "read",
  args: {},
  startedAt: 0,
};
let cells: Cell[] = [
  child,
  ...Array.from({ length: 80 }, (_, index) => user(index)),
  {
    kind: "assistant",
    turnId: "live",
    text: "# Latest\n\n" + "A streaming paragraph.\n\n".repeat(60),
    streaming: true,
  },
];
if (window.location.search === "?children")
  cells = [
    user(-100),
    ...Array.from({ length: 24 }, (_, index): Cell => ({
      ...child,
      callId: `child-${index}`,
      name: `Child ${index}`,
    })),
    ...Array.from({ length: 80 }, (_, index) => user(index)),
  ];
if (window.location.search === "?empty") cells = [];
const transcript = new DesktopTranscript();
transcript.update(cells);
let running = window.location.search !== "?empty";
let support = false;
let invalidate: () => void = () => {
  throw new Error("Canvas fixture is not mounted");
};
const changed = () => {
  transcript.update(cells);
  invalidate();
};
window.canvasFixture = {
  ready: false,
  grow() {
    cells = cells.map((cell) =>
      cell.kind === "assistant"
        ? { ...cell, text: cell.text + "Additional streaming paragraph.\n\n".repeat(8) }
        : cell,
    );
    changed();
  },
  prepend() {
    const parent: Cell = { kind: "tool", callId: "parent", name: "eval", args: {}, startedAt: 0 };
    cells = [parent, ...Array.from({ length: 25 }, (_, index) => user(index - 25)), ...cells];
    changed();
  },
  setRunning(value) {
    running = value;
    invalidate();
  },
  setSupport(value) {
    support = value;
    invalidate();
  },
  start() {
    cells = [user(0)];
    running = true;
    changed();
  },
  appendAssistant(text = "# Latest\n\n" + "A streaming paragraph.\n\n".repeat(60)) {
    cells = [
      ...cells,
      {
        kind: "assistant",
        turnId: "live",
        text,
        streaming: true,
      },
    ];
    changed();
  },
  appendTool() {
    cells = [
      ...cells,
      { kind: "tool", callId: "latest-tool", name: "Latest tool", args: {}, startedAt: 0 },
    ];
    changed();
  },
};

function renderRow(row: TranscriptRow): ReturnType<typeof h> {
  // Tall history fixtures deliberately expand groups to exercise virtualizer anchors.
  // The latest-tool inspection scenario uses the production outer scroll boundary.
  return row.kind === "steps"
    ? h(
        "div",
        {
          className: row.steps.some(
            ({ cell }) => cell.kind === "tool" && cell.callId === "latest-tool",
          )
            ? "cell tool-group-container"
            : undefined,
        },
        ...row.steps.map(renderCell),
      )
    : renderCell(row);
}
function renderCell({ cell }: { cell: Cell }): ReturnType<typeof h> {
  if (cell.kind === "user")
    return h(
      "article",
      { className: "cell user" },
      h("div", { className: "user-text" }, cell.text),
    );
  if (cell.kind === "tool")
    return h(
      Disclosure,
      { className: "cell tool", title: cell.name },
      h("pre", null, "Representative tool output\n".repeat(45)),
    );
  if (cell.kind === "assistant")
    return h("article", { className: "cell assistant" }, h(Markdown, null, cell.text));
  throw new Error("Unexpected fixture cell");
}
function Fixture() {
  const [, setRevision] = useState(0);
  useEffect(() => {
    invalidate = () => setRevision((value) => value + 1);
    window.canvasFixture.ready = true;
    return () => {
      window.canvasFixture.ready = false;
    };
  }, []);
  return h(
    Tooltip.Provider,
    null,
    h(
      "main",
      { style: { height: "100vh", color: "var(--ink)", background: "var(--surface-canvas)" } },
      h(ConversationCanvas, {
        rows: transcript.rows,
        running,
        renderRow,
        header: h("header", { className: "conversation-header" }, h("h1", null, "Conversation")),
        history:
          window.location.search === "?empty"
            ? null
            : h(Button, { onClick: () => window.canvasFixture.prepend() }, "Load earlier messages"),
        dock: h(
          "div",
          null,
          support &&
            h(
              "div",
              { className: "conversation-support" },
              h(
                "div",
                { className: "approval" },
                "Approval needs a decision",
                h("pre", null, "Command details\n".repeat(20)),
                h(Button, null, "Allow"),
              ),
            ),
          h(
            "div",
            { className: "composer-wrap" },
            h(
              "div",
              { className: "conversation-status" },
              h("span", null, running ? "Working…" : "Ready"),
              h("div", { className: "turn-stats" }, "Last turn · 800 in · 50 out"),
            ),
            h(
              "div",
              { className: "composer" },
              h("textarea", { "aria-label": "Message", placeholder: "Ask a follow-up…" }),
              h(
                "div",
                { className: "composer-actions" },
                h(Button, null, running ? "Stop" : "Send"),
              ),
            ),
            h("small", { className: "composer-hint" }, "Enter steer · Shift+Enter newline"),
          ),
        ),
      }),
    ),
  );
}
if (window.location.search === "?composer") await import("./composer-fixture.ts");
else if (window.location.search === "?updates")
  createRoot(document.getElementById("root")!).render(h(DesktopUpdates));
else createRoot(document.getElementById("root")!).render(h(Fixture));
