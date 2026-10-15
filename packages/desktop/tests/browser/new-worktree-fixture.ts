import { createElement as h, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopSession } from "../../src/session.ts";
import { NewWorktreeOption } from "../../src/components/worktree-controls.tsx";
import "../../src/styles.css";

const repository = "/repo";
const session = {
  plugins: {
    worktreeRepository: async (path: string) => (path === repository ? repository : null),
  },
} as unknown as DesktopSession;

interface Fixture {
  ready: boolean;
  setCwd(next: string): void;
}
declare global {
  interface Window {
    newWorktreeFixture?: Fixture;
  }
}

function CreationForm({ cwd }: { cwd: string }) {
  return h(
    "form",
    { className: "creation-form" },
    h(
      "div",
      { className: "folder-field" },
      h(
        "label",
        null,
        "Project folder",
        h("input", {
          className: "input",
          value: cwd,
          readOnly: true,
          "aria-label": "Project folder",
        }),
      ),
      h("button", { type: "button" }, "Choose folder…"),
    ),
    h(NewWorktreeOption, { session, cwd }),
    h(
      "div",
      { className: "creation-footer" },
      h("button", { type: "submit" }, "Create conversation"),
    ),
  );
}

function App() {
  const [cwd, setCwd] = useState(repository);
  useEffect(() => {
    window.newWorktreeFixture = { ready: true, setCwd };
    return () => {
      delete window.newWorktreeFixture;
    };
  }, []);
  return h("section", { className: "new-page" }, h(CreationForm, { cwd }));
}

createRoot(document.getElementById("root")!).render(h(App));
