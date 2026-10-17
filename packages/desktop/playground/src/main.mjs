import { createElement as h, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Checkbox, Dialog, DropdownMenu, Popover, Switch, Tooltip } from "radix-ui";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  Ellipsis,
  Layers,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Palette,
  Plus,
  Shield,
  Settings2,
  SlidersHorizontal,
  Terminal,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button, Field, Icon, IconButton, Input, PopoverControl, Section, Select } from "./ui.mjs";
import "./styles.css";

const { document, localStorage, matchMedia } = globalThis;
const accents = [
  ["Lilac", "#c8b8e8"],
  ["Sage", "#b6cdb4"],
  ["Powder blue", "#aecae7"],
  ["Peach", "#eac1aa"],
  ["Butter", "#e2d598"],
  ["Rose", "#dfb9c7"],
];
const media = matchMedia("(prefers-color-scheme: dark)");
const initial = { theme: "system", accent: accents[0][1], depth: 3, radius: 9 };
function readAppearance() {
  const raw = localStorage.getItem("harness-design-study");
  if (!raw) return initial;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return initial;
  }
  if (!value || typeof value !== "object") return initial;
  return {
    theme: ["light", "dark", "system"].includes(value.theme) ? value.theme : initial.theme,
    accent:
      typeof value.accent === "string" && /^#[0-9a-f]{6}$/iu.test(value.accent)
        ? value.accent
        : initial.accent,
    depth:
      Number.isInteger(value.depth) && value.depth >= 1 && value.depth <= 5
        ? value.depth
        : initial.depth,
    radius:
      Number.isInteger(value.radius) && value.radius >= 5 && value.radius <= 14
        ? value.radius
        : initial.radius,
  };
}
function applyAppearance(value) {
  document.documentElement.dataset.theme =
    value.theme === "system" ? (media.matches ? "dark" : "light") : value.theme;
  document.documentElement.style.setProperty("--accent", value.accent);
  document.documentElement.style.setProperty("--edge", `${value.depth}px`);
  document.documentElement.style.setProperty("--control-radius", `${value.radius}px`);
}
const storedAppearance = readAppearance();
applyAppearance(storedAppearance);

const hosts = [
  { id: "local", label: "Local", detail: "This computer" },
  { id: "ubuntu", label: "Ubuntu", detail: "SSH · development" },
  { id: "build", label: "Build server", detail: "SSH · builds" },
];
const composerDefaults = { sendWith: "Enter", showStats: true };
function readComposerPreferences() {
  const raw = localStorage.getItem("harness-design-composer");
  if (!raw) return composerDefaults;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return composerDefaults;
  }
  return {
    sendWith: ["Enter", "Shift+Enter"].includes(value?.sendWith) ? value.sendWith : "Enter",
    showStats: typeof value?.showStats === "boolean" ? value.showStats : true,
  };
}
function createConversation(fields) {
  return {
    model: "GPT 6.1",
    preset: "High",
    backend: "Local",
    state: "Idle",
    text: "",
    messages: [],
    feedback: "",
    approval: "",
    command: "Get-ChildItem D:\\shared\\builds",
    shell: "PowerShell",
    question: "",
    paragraphs: [],
    context: { used: 32000, capacity: 128000, messages: 21000, tools: 8000, instructions: 3000 },
    stats: { input: 12480, output: 846, speed: 62 },
    ...fields,
  };
}
function initialConversations() {
  return [
    createConversation({
      id: "host-switching",
      hostId: "local",
      title: "How host switching works",
      workspace: "D:\\projects\\harness",
      question: "Do my conversations keep running when I switch to another host?",
      paragraphs: [
        "Yes. Each host owns its conversations, so switching the visible host leaves accepted work running.",
        "When you switch back, the client reattaches to the same server. Your draft and any pending approval are still there.",
        "Closing the app follows your Local background preference. You can change it in connection management.",
      ],
      toolLabel: "Read connection and session lifecycle · 2 files",
      toolOutput:
        "packages/desktop/src/hosts.ts\npackages/desktop/src/session.ts\n\nA desktop session owns subscriptions and loaded conversation views. Host selection changes what you see.",
    }),
    createConversation({
      id: "composer",
      hostId: "local",
      title: "Simplify the composer",
      workspace: "D:\\projects\\harness",
      state: "Running",
      text: "Keep the model controls behind one compact chip.",
      question: "Can we make this input feel calmer?",
      paragraphs: [
        "I’m trying a compact composer: the selected model stays visible, details open on demand, and the chat keeps most of the space.",
      ],
    }),
    createConversation({
      id: "readme",
      hostId: "local",
      title: "Polish the README",
      workspace: "D:\\projects\\harness",
      question: "Make the setup instructions easier to scan.",
      paragraphs: [
        "The setup now has three short steps: install, configure a provider, and start a conversation. The longer details sit below.",
      ],
    }),
    createConversation({
      id: "linux",
      hostId: "ubuntu",
      title: "Check Linux startup",
      workspace: "~/projects/harness",
      backend: "Docker",
      state: "Running",
      question: "Check that the app starts cleanly on Linux.",
      paragraphs: [
        "The startup checks are running on Ubuntu. You can move to another host and come back to this conversation.",
      ],
    }),
    createConversation({
      id: "permissions",
      hostId: "ubuntu",
      title: "Review folder permissions",
      workspace: "~/projects/harness",
      state: "Approval",
      command: "ls -la /srv/shared/builds",
      shell: "Bash",
      question: "Inspect the shared build folder.",
      paragraphs: ["This command needs your approval before it can continue."],
    }),
    createConversation({
      id: "build",
      hostId: "build",
      title: "Prepare a release",
      workspace: "~/builds/harness",
      state: "Approval",
      command: "ls -la /srv/releases",
      shell: "Bash",
      question: "Prepare the release artifacts.",
      paragraphs: [
        "The build is ready for the next step. There’s an approval waiting here while you review the artifacts.",
      ],
    }),
  ];
}

function ToolDisclosure({ label, output }) {
  return h(
    "details",
    { className: "tool-row" },
    h(
      "summary",
      null,
      h(Icon, { component: ChevronRight, className: "disclosure-chevron" }),
      label,
    ),
    h("pre", { className: "tool-output" }, output),
  );
}

function ConversationSidebar({ hostId, conversations, selectedId, onHost, onConversation, onNew }) {
  const host = hosts.find((item) => item.id === hostId);
  if (!host) throw new Error("Unknown preview host");
  return h(
    "div",
    { className: "conversation-nav" },
    h(
      "div",
      { className: "host-heading" },
      h(
        PopoverControl,
        {
          label: "Switch host",
          align: "start",
          trigger: h(
            Button,
            {
              variant: "ghost",
              size: "sm",
              className: "host-trigger",
              "aria-label": `Switch host: ${host.label}`,
            },
            h(Icon, { component: Monitor }),
            host.label,
            h(Icon, { component: ChevronDown }),
          ),
        },
        h("h3", null, "Hosts"),
        h(
          "div",
          { className: "host-options" },
          hosts.map((item) => {
            const working = conversations.filter(
              (conversation) => conversation.hostId === item.id && conversation.state === "Running",
            ).length;
            const approvals = conversations.filter(
              (conversation) =>
                conversation.hostId === item.id &&
                conversation.state === "Approval" &&
                !conversation.approval,
            ).length;
            return h(
              Popover.Close,
              { asChild: true, key: item.id },
              h(
                "button",
                {
                  type: "button",
                  className: "host-option selection-item",
                  "aria-pressed": hostId === item.id,
                  onClick: () => onHost(item.id),
                },
                h(
                  "span",
                  { className: "host-option-copy" },
                  h("span", null, item.label),
                  h("span", { className: "field-hint" }, item.detail),
                  (working > 0 || approvals > 0) &&
                    h(
                      "span",
                      { className: "field-hint" },
                      [
                        working > 0 && `${working} working`,
                        approvals > 0 && `${approvals} awaiting approval`,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    ),
                ),
                hostId === item.id && h(Icon, { component: Check }),
              ),
            );
          }),
        ),
      ),
      h(IconButton, { label: "New conversation", icon: Plus, size: "sm", onClick: onNew }),
    ),
    h(
      "nav",
      { className: "conversation-list", "aria-label": `${host.label} conversations` },
      conversations
        .filter((conversation) => conversation.hostId === hostId)
        .map((conversation) =>
          h(
            "button",
            {
              key: conversation.id,
              className: "selection-item",
              type: "button",
              "aria-current": selectedId === conversation.id ? "true" : undefined,
              "aria-label": `${conversation.title} · ${conversation.approval ? "Idle" : conversation.state}`,
              onClick: () => onConversation(conversation.id),
            },
            h("span", { className: "conversation-title" }, conversation.title),
            conversation.state === "Running" &&
              h(Icon, { component: LoaderCircle, className: "conversation-status loading-icon" }),
            conversation.state === "Approval" &&
              !conversation.approval &&
              h(Icon, {
                component: TriangleAlert,
                className: "conversation-status status-warning",
              }),
            conversation.state === "Error" &&
              h(Icon, { component: TriangleAlert, className: "conversation-status status-danger" }),
          ),
        ),
    ),
  );
}

function ComposerSettings({ value, setValue }) {
  return h(
    PopoverControl,
    {
      label: "Composer settings",
      side: "top",
      align: "start",
      trigger: h(
        Button,
        {
          variant: "ghost",
          size: "sm",
          className: "icon-control",
          "aria-label": "Composer settings",
        },
        h(Icon, { component: Settings2 }),
      ),
    },
    h("h3", null, "Composer settings"),
    h(
      "div",
      { className: "mt-4" },
      h(Field, { label: "Send shortcut" }, (props) =>
        h(Select, {
          ...props,
          options: ["Enter", "Shift+Enter"],
          value: value.sendWith,
          onChange: (event) => setValue({ ...value, sendWith: event.target.value }),
        }),
      ),
    ),
    h(
      "p",
      { className: "field-hint mt-3" },
      "Enter and Shift+Enter swap send and newline. Ctrl/Cmd+Enter queues while working. Escape stops without clearing the draft.",
    ),
    h(
      "label",
      { className: "flex items-center gap-3 text-[13px] mt-5" },
      h(
        Switch.Root,
        {
          className: "switch",
          checked: value.showStats,
          onCheckedChange: (showStats) => setValue({ ...value, showStats }),
        },
        h(Switch.Thumb, { className: "switch-thumb" }),
      ),
      "Show last turn stats",
    ),
    h(Popover.Close, { asChild: true }, h(Button, { size: "sm", className: "mt-5" }, "Done")),
  );
}

function ContextIndicator({ context }) {
  const percent = Math.round((context.used / context.capacity) * 100);
  return h(
    PopoverControl,
    {
      label: "Context window",
      side: "top",
      trigger: h(
        Button,
        {
          variant: "ghost",
          className: "context-control",
          "aria-label": `Context usage: ${percent}%`,
        },
        h("span", { className: "context-ring", style: { "--context-used": `${percent}%` } }),
      ),
    },
    h("h3", null, "Context window"),
    h(
      "p",
      { className: "context-total" },
      `${percent}% used`,
      h(
        "span",
        { className: "field-hint block mt-1" },
        `${context.used.toLocaleString()} / ${context.capacity.toLocaleString()} tokens`,
      ),
    ),
    h(
      "dl",
      { className: "context-breakdown" },
      [
        ["Messages", context.messages],
        ["Tool results", context.tools],
        ["Instructions", context.instructions],
        ["Remaining", context.capacity - context.used],
      ].map(([label, count]) =>
        h("div", { key: label }, h("dt", null, label), h("dd", null, count.toLocaleString())),
      ),
    ),
    h("p", { className: "field-hint mt-4" }, "Sample values for this design preview."),
  );
}

function Appearance({ value, setValue }) {
  const update = (patch) => setValue({ ...value, ...patch });
  return h(
    PopoverControl,
    {
      label: "Appearance controls",
      trigger: h(
        Button,
        { variant: "ghost", size: "sm" },
        h(Icon, { component: SlidersHorizontal }),
        "Appearance",
      ),
    },
    h("h3", null, "Appearance"),
    h(
      "div",
      { className: "theme-options mb-5", "aria-label": "Theme" },
      ["system", "light", "dark"].map((theme) =>
        h(
          Button,
          {
            key: theme,
            variant: value.theme === theme ? "accent" : "neutral",
            size: "sm",
            "aria-pressed": value.theme === theme,
            onClick: () => update({ theme }),
          },
          theme[0].toUpperCase() + theme.slice(1),
        ),
      ),
    ),
    h("p", { className: "field-label text-[12px] mb-3" }, "Accent"),
    h(
      "div",
      { className: "flex flex-wrap gap-2 mb-3" },
      accents.map(([name, color]) =>
        h(
          "button",
          {
            key: name,
            type: "button",
            className: "swatch",
            "aria-label": name,
            "aria-pressed": value.accent.toLowerCase() === color,
            style: { "--swatch": color },
            onClick: () => update({ accent: color }),
          },
          value.accent.toLowerCase() === color && h(Icon, { component: Check }),
        ),
      ),
    ),
    h(
      "label",
      { className: "flex items-center gap-3 text-[12px] text-muted-ink mb-5" },
      h("input", {
        className: "custom-color",
        type: "color",
        "aria-label": "Custom accent",
        value: value.accent,
        onChange: (event) => update({ accent: event.target.value }),
      }),
      "Custom color",
    ),
    h(
      "label",
      { className: "field mb-4" },
      h("span", null, `Button edge · ${value.depth}px`),
      h("input", {
        className: "appearance-range",
        type: "range",
        min: 1,
        max: 5,
        value: value.depth,
        onChange: (event) => update({ depth: Number(event.target.value) }),
      }),
    ),
    h(
      "label",
      { className: "field mb-5" },
      h("span", null, `Control corners · ${value.radius}px`),
      h("input", {
        className: "appearance-range",
        type: "range",
        min: 5,
        max: 14,
        value: value.radius,
        onChange: (event) => update({ radius: Number(event.target.value) }),
      }),
    ),
    h(Popover.Close, { asChild: true }, h(Button, { size: "sm" }, "Done")),
  );
}

function ModelPicker({ model, preset, setModel, setPreset }) {
  return h(
    PopoverControl,
    {
      label: "Model and preset",
      side: "top",
      align: "start",
      trigger: h(
        Button,
        { variant: "ghost", className: "model-chip" },
        model,
        h("span", { className: "chip-detail" }, "· ", preset),
        h(Icon, { component: ChevronDown }),
      ),
    },
    h("h3", null, "Model & preset"),
    h(
      "div",
      { className: "grid gap-4" },
      h(Field, { label: "Model" }, (props) =>
        h(Select, {
          ...props,
          options: ["GPT 6.1", "GPT 6", "Demo"],
          value: model,
          onChange: (event) => setModel(event.target.value),
        }),
      ),
      h(Field, { label: "Preset" }, (props) =>
        h(Select, {
          ...props,
          options: ["High", "Medium", "Low"],
          value: preset,
          onChange: (event) => setPreset(event.target.value),
        }),
      ),
      h(
        Popover.Close,
        { asChild: true },
        h(Button, { size: "sm", className: "justify-self-start" }, "Done"),
      ),
    ),
  );
}

function ActionMenu({ onAction }) {
  return h(
    DropdownMenu.Root,
    null,
    h(
      DropdownMenu.Trigger,
      { asChild: true },
      h(
        Button,
        { variant: "ghost", className: "icon-control", "aria-label": "More actions" },
        h(Icon, { component: Ellipsis }),
      ),
    ),
    h(
      DropdownMenu.Portal,
      null,
      h(
        DropdownMenu.Content,
        { className: "menu", sideOffset: 8, collisionPadding: 12 },
        [
          [Copy, "Copy conversation"],
          [Palette, "View appearance"],
        ].map(([icon, label]) =>
          h(
            DropdownMenu.Item,
            { key: label, className: "menu-item", onSelect: () => onAction(label) },
            h(Icon, { component: icon }),
            label,
          ),
        ),
      ),
    ),
  );
}

function ChatPreview({ conversation, update, composerPreferences, setComposerPreferences }) {
  const { model, preset, backend, state, text, messages, feedback, approval, stats } = conversation;
  const setModel = (model) => update({ model });
  const setPreset = (preset) => update({ preset });
  const setBackend = (backend) => update({ backend });
  const setState = (state) => update({ state });
  const setFeedback = (feedback) => update({ feedback });
  const setApproval = (approval) => update({ approval });
  const intent = "Steer";
  const alternative = "Queue";
  const running = state === "Running" || state === "Approval";
  function send(useAlternative = false) {
    if (!text.trim()) return;
    const delivery = running ? (useAlternative ? alternative : intent) : "Send";
    update({
      messages: [...messages, { text: text.trim(), intent: delivery }],
      text: "",
      feedback: running ? `${delivery} message added to preview.` : "Message added to preview.",
    });
  }
  return h(
    "div",
    { className: "chat-shell" },
    h(
      "div",
      { className: "chat-heading" },
      h("div", null, h("h2", null, conversation.title), h("p", null, conversation.workspace)),
      h(
        PopoverControl,
        {
          label: "Preview state",
          trigger: h(
            Button,
            { variant: "ghost", size: "sm" },
            "Preview",
            h(Icon, { component: ChevronDown }),
          ),
        },
        h("h3", null, "Conversation state"),
        h(Field, { label: "Preview state" }, (props) =>
          h(Select, {
            ...props,
            value: state,
            options: ["Idle", "Running", "Approval", "Error"],
            onChange: (event) => {
              update({ state: event.target.value, approval: "" });
            },
          }),
        ),
        h("p", { className: "field-hint mt-3" }, "These interactions stay in this design study."),
      ),
    ),
    h(
      "div",
      { className: "chat-thread" },
      conversation.question && h("div", { className: "user-bubble" }, conversation.question),
      conversation.paragraphs.length > 0 &&
        h(
          "article",
          null,
          h(
            "div",
            { className: "assistant-copy" },
            h("p", null, conversation.paragraphs[0]),
            conversation.toolLabel &&
              h(ToolDisclosure, { label: conversation.toolLabel, output: conversation.toolOutput }),
            conversation.paragraphs
              .slice(1)
              .map((paragraph, index) => h("p", { key: index }, paragraph)),
          ),
          h("p", { className: "worked" }, running ? "Working…" : "Worked for 8s"),
        ),
      state === "Approval" &&
        h(
          "section",
          { className: "approval", "aria-label": "Approval request" },
          h("h3", null, "Allow this command?"),
          h("p", { className: "field-hint mt-1" }, `Outside the workspace · ${conversation.shell}`),
          h("pre", null, conversation.command),
          approval
            ? h("p", { role: "status" }, approval)
            : h(
                "div",
                { className: "flex gap-3 flex-wrap" },
                h(
                  Button,
                  { onClick: () => setApproval("Denied in preview. No command was executed.") },
                  "Deny",
                ),
                h(
                  Button,
                  {
                    variant: "accent",
                    onClick: () => setApproval("Allowed in preview. No command was executed."),
                  },
                  "Allow",
                ),
              ),
        ),
      state === "Error" &&
        h(
          "div",
          { className: "notice notice-danger mt-6", role: "alert" },
          "The selected provider is unavailable. Your conversation and draft are preserved.",
          h(
            "div",
            { className: "mt-3" },
            h(
              Button,
              {
                size: "sm",
                onClick: () => {
                  setState("Idle");
                  setFeedback("Preview returned to idle.");
                },
              },
              "Retry",
            ),
          ),
        ),
      messages.map((message, index) =>
        h(
          "div",
          { key: index, className: "user-bubble mt-7" },
          h("span", { className: "field-hint block mb-1" }, message.intent),
          message.text,
        ),
      ),
    ),
    h(
      "div",
      { className: "composer-wrap" },
      h(
        "div",
        { className: "composer-status" },
        h(
          "span",
          { role: "status" },
          state === "Approval" ? "Waiting for approval" : running ? "Working…" : "Ready",
        ),
        composerPreferences.showStats &&
          stats &&
          h(
            "div",
            { className: "turn-stats", "aria-label": "Last turn stats (sample)" },
            h("span", null, "Last turn"),
            h("span", null, `${stats.input.toLocaleString()} in`),
            h("span", null, `${stats.output.toLocaleString()} out`),
            h("span", null, `${stats.speed} tok/s`),
          ),
      ),
      h(
        "div",
        { className: "composer" },
        h("textarea", {
          "aria-label": "Message",
          placeholder: "Ask a follow-up…",
          value: text,
          onChange: (event) => update({ text: event.target.value }),
          onKeyDown: (event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.altKey)
              return;
            if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
              if (running) {
                event.preventDefault();
                setState("Idle");
                setFeedback("Preview turn stopped.");
              }
              return;
            }
            if (event.key !== "Enter") return;
            if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
              event.preventDefault();
              send(true);
            } else if (
              !event.ctrlKey &&
              !event.metaKey &&
              event.shiftKey === (composerPreferences.sendWith === "Shift+Enter")
            ) {
              event.preventDefault();
              send();
            }
          },
        }),
        h(
          "div",
          { className: "composer-footer" },
          h(ModelPicker, { model, preset, setModel, setPreset }),
          h(
            PopoverControl,
            {
              label: "Execution backend",
              side: "top",
              align: "start",
              trigger: h(
                Button,
                { variant: "ghost", size: "sm", className: "text-muted-ink" },
                h(Icon, { component: Shield }),
                backend,
              ),
            },
            h("h3", null, "Execution backend"),
            h(Field, { label: "Sandbox" }, (props) =>
              h(Select, {
                ...props,
                options: ["Local", "Docker"],
                value: backend,
                onChange: (event) => setBackend(event.target.value),
              }),
            ),
            h(
              Popover.Close,
              { asChild: true },
              h(Button, { size: "sm", className: "mt-4" }, "Done"),
            ),
          ),
          h(ComposerSettings, { value: composerPreferences, setValue: setComposerPreferences }),
          h(
            "div",
            { className: "ml-auto flex items-center gap-2" },
            h(ContextIndicator, { context: conversation.context }),
            h(
              Button,
              {
                variant: "accent",
                onClick: () => {
                  if (running && !text.trim()) {
                    setState("Idle");
                    setFeedback("Preview turn stopped.");
                  } else send();
                },
                disabled: !running && !text.trim(),
              },
              h(Icon, { component: ArrowUp }),
              running && !text.trim() ? "Stop" : running ? intent : "Send",
            ),
          ),
        ),
      ),
      h(
        "div",
        { className: "composer-help" },
        h(
          "span",
          null,
          `${composerPreferences.sendWith} ${running ? "steer" : "send"} · ${composerPreferences.sendWith === "Enter" ? "Shift+Enter" : "Enter"} newline${running ? " · Ctrl+Enter queue · Esc stop" : ""}`,
        ),
        h("span", { role: "status", "aria-live": "polite" }, feedback),
      ),
    ),
  );
}

function DialogSample({ setFeedback }) {
  const [open, setOpen] = useState(false);
  return h(
    Dialog.Root,
    { open, onOpenChange: setOpen },
    h(
      Dialog.Trigger,
      { asChild: true },
      h(Button, null, h(Icon, { component: Plus }), "Add connection"),
    ),
    h(
      Dialog.Portal,
      null,
      h(Dialog.Overlay, { className: "overlay" }),
      h(
        Dialog.Content,
        { className: "dialog" },
        h(
          "div",
          { className: "flex justify-between gap-4 items-start" },
          h(Dialog.Title, { className: "dialog-title" }, "Add a connection"),
          h(
            Dialog.Close,
            { asChild: true },
            h(
              Button,
              { variant: "ghost", className: "icon-control", "aria-label": "Close dialog" },
              h(Icon, { component: X }),
            ),
          ),
        ),
        h(
          Dialog.Description,
          { className: "dialog-description" },
          "Choose a name and destination. This example stays in the playground.",
        ),
        h(
          "form",
          {
            onSubmit: (event) => {
              event.preventDefault();
              const data = new globalThis.FormData(event.currentTarget);
              setFeedback(`Connection “${data.get("name")}” added to preview.`);
              setOpen(false);
            },
          },
          h(
            "div",
            { className: "grid gap-4" },
            h(Field, { label: "Name" }, (props) =>
              h(Input, { ...props, name: "name", placeholder: "Build server", required: true }),
            ),
            h(
              Field,
              { label: "SSH destination", hint: "Use an alias from your SSH config." },
              (props) =>
                h(Input, {
                  ...props,
                  name: "destination",
                  placeholder: "user@host",
                  required: true,
                }),
            ),
          ),
          h(
            "div",
            { className: "flex justify-end gap-3 mt-6 flex-wrap" },
            h(Dialog.Close, { asChild: true }, h(Button, null, "Cancel")),
            h(Button, { variant: "accent", type: "submit" }, "Add connection"),
          ),
        ),
      ),
    ),
  );
}

function ContrastAudit({ appearance }) {
  const [audit, setAudit] = useState({ status: "idle" });
  const signature = JSON.stringify(appearance);
  const currentSnapshot =
    audit.status === "complete" &&
    audit.signature === signature &&
    audit.theme === document.documentElement.dataset.theme;
  async function runAudit() {
    const theme = document.documentElement.dataset.theme;
    setAudit({ status: "running" });
    try {
      const { default: axe } = await import("axe-core");
      const results = await axe.run(document, {
        runOnly: { type: "rule", values: ["color-contrast"] },
        resultTypes: ["violations", "incomplete", "passes"],
      });
      const findings = (rules) =>
        rules.flatMap((rule) =>
          rule.nodes.map((node) => ({
            target: node.target.join(" "),
            summary: node.failureSummary,
          })),
        );
      setAudit({
        status: "complete",
        theme,
        signature,
        passed: results.passes.reduce((count, rule) => count + rule.nodes.length, 0),
        violations: findings(results.violations),
        incomplete: findings(results.incomplete),
      });
    } catch (error) {
      setAudit({
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return h(
    "div",
    { className: "contrast-audit" },
    h(
      "div",
      { className: "flex items-center gap-3 flex-wrap" },
      h(
        Button,
        { size: "sm", loading: audit.status === "running", onClick: runAudit },
        "Check text contrast",
      ),
      h("span", { className: "field-hint" }, "axe-core · rendered page"),
    ),
    h(
      "p",
      { className: "field-hint mt-3" },
      "Checks visible text in this theme. Rerun after changes. Control boundaries and selection prominence still need visual review.",
    ),
    h(
      "p",
      { className: "audit-result", role: audit.status === "failed" ? "alert" : "status" },
      audit.status === "running"
        ? "Checking text contrast…"
        : audit.status === "failed"
          ? `Audit failed: ${audit.message}`
          : currentSnapshot
            ? `${audit.theme === "dark" ? "Dark" : "Light"} snapshot: ${audit.passed} text checks passed · ${audit.violations.length} failed · ${audit.incomplete.length} need review`
            : audit.status === "complete"
              ? "Appearance changed. Run the audit again."
              : "",
    ),
    currentSnapshot &&
      (audit.violations.length > 0 || audit.incomplete.length > 0) &&
      h(ToolDisclosure, {
        label: "Contrast findings",
        output: [
          ...audit.violations.map((node) => `FAIL: ${node.target}\n${node.summary}`),
          ...audit.incomplete.map((node) => `REVIEW: ${node.target}\n${node.summary}`),
        ].join("\n\n"),
      }),
  );
}

function SurfaceStateMatrix({ appearance, onAction }) {
  const [selected, setSelected] = useState({ canvas: true, panel: true });
  return h(
    Section,
    { title: "Surfaces & button states" },
    h(
      "p",
      { className: "field-hint mb-4" },
      "The same buttons on two surfaces. Hover, press, or use Tab to compare states; click Option to toggle selection.",
    ),
    h(
      "div",
      { className: "state-matrix" },
      [
        ["canvas", "Canvas"],
        ["panel", "Panel"],
      ].map(([surface, label]) =>
        h(
          "section",
          {
            key: surface,
            className: `state-surface state-surface-${surface}`,
            "aria-label": `${label} button states`,
          },
          h("h4", null, label),
          h(
            "div",
            { className: "state-samples" },
            h(
              "div",
              { className: "sample-group" },
              h(
                Button,
                { size: "sm", onClick: () => onAction(`${label} action pressed.`) },
                "Action",
              ),
              h("p", { className: "sample-label" }, "Default"),
            ),
            h(
              "div",
              { className: "sample-group" },
              h(
                Button,
                {
                  size: "sm",
                  variant: selected[surface] ? "accent" : "neutral",
                  "aria-pressed": selected[surface],
                  onClick: () =>
                    setSelected((current) => ({ ...current, [surface]: !current[surface] })),
                },
                "Option",
              ),
              h("p", { className: "sample-label" }, "Selectable"),
            ),
            h(
              "div",
              { className: "sample-group" },
              h(Button, { size: "sm", disabled: true }, "Action"),
              h("p", { className: "sample-label" }, "Disabled"),
            ),
          ),
        ),
      ),
    ),
    h(ContrastAudit, { appearance }),
  );
}

function TintedButtonSamples({ onAction }) {
  const [customTint, setCustomTint] = useState("#aecae7");
  const [selected, setSelected] = useState({ Sage: true, Rose: true, Butter: true, Custom: true });
  return h(
    Section,
    { title: "Tinted buttons" },
    h(
      "p",
      { className: "field-hint mb-4" },
      "One tint color drives the face, matching border, base, and interaction states.",
    ),
    h(
      "label",
      { className: "flex items-center gap-3 field-hint mb-4" },
      h("input", {
        type: "color",
        className: "custom-color",
        "aria-label": "Custom button tint",
        value: customTint,
        onChange: (event) => setCustomTint(event.target.value),
      }),
      "Custom button tint",
    ),
    h(
      "div",
      { className: "tinted-matrix" },
      [
        ["Sage", "#b6cdb4"],
        ["Rose", "#dfb9c7"],
        ["Butter", "#e2d598"],
        ["Custom", customTint],
      ].map(([label, tint]) =>
        h(
          "section",
          {
            key: label,
            className: "state-surface state-surface-panel",
            "aria-label": `${label} tinted buttons`,
          },
          h("h4", null, label),
          h(
            "div",
            { className: "state-samples" },
            h(
              Button,
              {
                variant: "tinted",
                tint,
                size: "sm",
                onClick: () => onAction(`${label} sample pressed.`),
              },
              "Action",
            ),
            h(
              Button,
              {
                variant: "tinted",
                tint,
                size: "sm",
                "aria-pressed": selected[label],
                onClick: () => setSelected((current) => ({ ...current, [label]: !current[label] })),
              },
              "Option",
            ),
          ),
        ),
      ),
    ),
  );
}

function Components({ appearance }) {
  const [feedback, setFeedback] = useState("Try a control to see its state.");
  const [saving, setSaving] = useState(false);
  return h(
    "div",
    { className: "page-content" },
    h("h2", null, "Small details. One language."),
    h(
      "p",
      { className: "page-lead" },
      "Neutral surfaces, consistent rhythm, a little color under your fingertips. The same controls serve the composer, settings, and connection forms.",
    ),
    h(SurfaceStateMatrix, { appearance, onAction: setFeedback }),
    h(TintedButtonSamples, { onAction: setFeedback }),
    h(
      Section,
      { title: "Buttons" },
      h(
        "div",
        { className: "flex flex-wrap items-start gap-x-6 gap-y-6" },
        [
          ["accent", "Save changes", "Accented"],
          ["neutral", "Cancel", "Neutral"],
          ["ghost", "Quiet action", "Low emphasis"],
          ["danger", "Remove", "Destructive"],
        ].map(([variant, label, caption]) =>
          h(
            "div",
            { key: variant, className: "sample-group" },
            h(Button, { variant, onClick: () => setFeedback(`${label} pressed.`) }, label),
            h("p", { className: "sample-label" }, caption),
          ),
        ),
      ),
      h(
        "div",
        { className: "flex flex-wrap items-center gap-4 mt-7" },
        h(Button, { disabled: true }, "Disabled"),
        h(
          Button,
          {
            loading: saving,
            onClick: () => {
              setSaving(true);
              setFeedback("Loading state active. Finish the sample to reset it.");
            },
          },
          saving ? "Saving…" : "Try loading",
        ),
        saving &&
          h(
            Button,
            {
              variant: "ghost",
              onClick: () => {
                setSaving(false);
                setFeedback("Sample saved.");
              },
            },
            "Finish sample",
          ),
        h(IconButton, {
          label: "Copy",
          icon: Copy,
          onClick: () => setFeedback("Copy action pressed."),
        }),
        h(IconButton, {
          label: "More",
          icon: Ellipsis,
          onClick: () => setFeedback("More action pressed."),
        }),
      ),
      h(
        "div",
        { className: "flex flex-wrap items-end gap-4 mt-7" },
        ["sm", "md", "lg"].map((size) =>
          h(
            Button,
            { key: size, size, onClick: () => setFeedback(`${size} control pressed.`) },
            { sm: "Small", md: "Standard", lg: "Large" }[size],
          ),
        ),
      ),
    ),
    h(
      Section,
      { title: "Inputs & choices" },
      h(
        "form",
        {
          className: "grid gap-5",
          onSubmit: (event) => {
            event.preventDefault();
            setFeedback(
              `Workspace “${new globalThis.FormData(event.currentTarget).get("workspace") || "Untitled"}” saved in preview.`,
            );
          },
        },
        h(
          "div",
          { className: "grid sm:grid-cols-2 gap-5" },
          h(Field, { label: "Workspace", hint: "A folder for this conversation." }, (props) =>
            h(Input, { ...props, name: "workspace", defaultValue: "D:\\projects\\harness" }),
          ),
          h(Field, { label: "Default sandbox" }, (props) =>
            h(Select, { ...props, name: "sandbox", options: ["Local", "Docker", "Native"] }),
          ),
          h(
            Field,
            { label: "Provider URL", error: "Enter a complete URL, including https://." },
            (props) =>
              h(Input, {
                ...props,
                defaultValue: "gateway",
                "aria-label": "Provider URL error example",
              }),
          ),
          h(Field, { label: "API key", hint: "A disabled field example." }, (props) =>
            h(Input, { ...props, disabled: true, placeholder: "Not configured", type: "password" }),
          ),
        ),
        h(Field, { label: "Instructions" }, (props) =>
          h("textarea", { ...props, className: "input", placeholder: "Add a short instruction…" }),
        ),
        h(
          "div",
          { className: "flex flex-wrap gap-7 items-center" },
          h(
            "label",
            { className: "flex items-center gap-3 text-[13px]" },
            h(
              Switch.Root,
              {
                className: "switch",
                defaultChecked: true,
                name: "systemTheme",
                onCheckedChange: (checked) =>
                  setFeedback(`Follow system theme ${checked ? "on" : "off"}.`),
              },
              h(Switch.Thumb, { className: "switch-thumb" }),
            ),
            "Follow system theme",
          ),
          h(
            "label",
            { className: "flex items-center gap-3 text-[13px]" },
            h(
              Checkbox.Root,
              {
                className: "check",
                name: "keepRunning",
                onCheckedChange: (checked) =>
                  setFeedback(`Background preference ${checked ? "on" : "off"}.`),
              },
              h(Checkbox.Indicator, null, h(Icon, { component: Check })),
            ),
            "Keep Local running on exit",
          ),
        ),
        h(
          Button,
          { type: "submit", variant: "accent", className: "justify-self-start" },
          "Save preferences",
        ),
      ),
    ),
    h(
      Section,
      { title: "Overlays & disclosure" },
      h(
        "div",
        { className: "flex flex-wrap items-center gap-4" },
        h(DialogSample, { setFeedback }),
        h(
          PopoverControl,
          {
            label: "Model example",
            trigger: h(Button, null, "Model options", h(Icon, { component: ChevronDown })),
          },
          h("h3", null, "Choose a model"),
          h(Field, { label: "Model" }, (props) =>
            h(Select, {
              ...props,
              options: ["GPT 6.1", "GPT 6", "Demo"],
              onChange: (event) => setFeedback(`${event.target.value} selected.`),
            }),
          ),
        ),
        h(ActionMenu, { onAction: setFeedback }),
      ),
      h(ToolDisclosure, {
        label: "Read 2 files · completed",
        output:
          "README.md\nPLAN.md\n\nTool arguments and output stay available without competing with the conversation.",
      }),
    ),
    h(
      Section,
      { title: "Feedback & status" },
      h(
        "div",
        { className: "flex flex-wrap gap-6 mb-5" },
        [
          [Check, "Complete", "success"],
          [LoaderCircle, "Working", ""],
          [TriangleAlert, "Approval needed", "warning"],
          [Circle, "Failed", "danger"],
        ].map(([icon, label, tone]) =>
          h(
            "span",
            { key: label, className: `badge badge-${tone}` },
            h(Icon, { component: icon }),
            label,
          ),
        ),
      ),
      h(
        "div",
        { className: "grid gap-3" },
        h(
          "div",
          { className: "notice" },
          "Your draft is saved while you move between conversations.",
        ),
        h(
          "div",
          { className: "notice notice-warning" },
          "Changing the sandbox stops this conversation’s background work.",
        ),
        h(
          "div",
          { className: "notice notice-danger" },
          "Provider unavailable. Choose a model or check its connection.",
        ),
      ),
    ),
    h("p", { className: "feedback", role: "status", "aria-live": "polite" }, feedback),
  );
}

function Foundations() {
  return h(
    "div",
    { className: "page-content" },
    h("h2", null, "Mostly neutral. Deliberately tactile."),
    h(
      "p",
      { className: "page-lead" },
      "Color stays small. Text and space do the organizing. Depth tells you what can be pressed.",
    ),
    h(
      Section,
      { title: "One accent at a time" },
      h(
        "div",
        { className: "foundation-swatches" },
        accents.map(([name, color]) =>
          h(
            "div",
            { key: name },
            h("div", { className: "foundation-swatch", style: { "--swatch": color } }),
            h("p", { className: "sample-label" }, name),
          ),
        ),
      ),
    ),
    h(
      Section,
      { title: "Neutral surfaces" },
      h(
        "div",
        { className: "foundation-swatches" },
        [
          ["Canvas", "var(--surface-canvas)"],
          ["Sidebar", "var(--surface-sidebar)"],
          ["Panel", "var(--surface-panel)"],
          ["Button", "var(--button-face)"],
          ["Selected", "var(--button-selected-face)"],
          ["Text", "var(--ink)"],
        ].map(([name, color]) =>
          h(
            "div",
            { key: name },
            h("div", { className: "foundation-swatch", style: { "--swatch": color } }),
            h("p", { className: "sample-label" }, name),
          ),
        ),
      ),
    ),
    h(
      Section,
      { title: "Typography" },
      [
        [24, 500, "Page title"],
        [16, 500, "Section title"],
        [14, 400, "The conversation takes center stage."],
        [12, 400, "Secondary context stays quiet and readable."],
        [12, 400, "packages/desktop/src/routes.tsx"],
      ].map(([size, weight, text], index) =>
        h(
          "div",
          { key: index, className: "type-specimen" },
          h("span", { className: "type-meta" }, `${size}px / ${weight}`),
          h(
            "span",
            {
              className: index === 4 ? "mono break-all" : "",
              style: { fontSize: size, fontWeight: weight },
            },
            text,
          ),
        ),
      ),
    ),
    h(
      Section,
      { title: "Space & depth" },
      h(
        "div",
        { className: "flex flex-wrap items-end gap-6" },
        [8, 12, 16, 24, 32].map((size) =>
          h(
            "div",
            { key: size },
            h("div", {
              style: { width: size, height: size, background: "var(--ink)", borderRadius: 2 },
            }),
            h("p", { className: "sample-label" }, `${size}px`),
          ),
        ),
      ),
      h(
        "div",
        { className: "flex flex-wrap items-center gap-5 mt-8" },
        [1, 2, 3, 4].map((depth) =>
          h(
            Button,
            { key: depth, variant: "accent", style: { "--edge": `${depth}px` } },
            `${depth}px edge`,
          ),
        ),
      ),
    ),
  );
}

function App() {
  const [page, setPage] = useState("Conversation");
  const [appearance, setAppearance] = useState(storedAppearance);
  const [composerPreferences, setComposerPreferences] = useState(readComposerPreferences);
  const [conversations, setConversations] = useState(initialConversations);
  const [hostId, setHostId] = useState("local");
  const [selectedByHost, setSelectedByHost] = useState({
    local: "host-switching",
    ubuntu: "linux",
    build: "build",
  });
  const selectedId = selectedByHost[hostId];
  const conversation = conversations.find(
    (item) => item.hostId === hostId && item.id === selectedId,
  );
  if (!conversation) throw new Error("Selected preview conversation is missing");
  function updateConversation(patch) {
    setConversations((current) =>
      current.map((item) => (item.id === selectedId ? { ...item, ...patch } : item)),
    );
  }
  function newConversation() {
    const id = globalThis.crypto.randomUUID();
    setConversations((current) => [
      ...current,
      createConversation({
        id,
        hostId,
        title: "New conversation",
        workspace: conversation.workspace,
        command:
          hostId === "local" ? "Get-ChildItem D:\\shared\\builds" : "ls -la /srv/shared/builds",
        shell: hostId === "local" ? "PowerShell" : "Bash",
        context: { used: 0, capacity: 128000, messages: 0, tools: 0, instructions: 0 },
        stats: null,
      }),
    ]);
    setSelectedByHost((current) => ({ ...current, [hostId]: id }));
  }
  useEffect(() => {
    localStorage.setItem("harness-design-composer", JSON.stringify(composerPreferences));
  }, [composerPreferences]);
  useEffect(() => {
    applyAppearance(appearance);
    localStorage.setItem("harness-design-study", JSON.stringify(appearance));
    const change = () => applyAppearance(appearance);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [appearance]);
  return h(
    Tooltip.Provider,
    { delayDuration: 300 },
    h(
      "div",
      { className: "app-layout" },
      h(
        "aside",
        { className: "app-side" },
        h("div", { className: "brand" }, h(Icon, { component: Terminal }), "Harness"),
        h(
          "div",
          null,
          h(
            "nav",
            { className: "section-nav", "aria-label": "Playground sections" },
            [
              [MessageSquare, "Conversation"],
              [Layers, "Components"],
              [Palette, "Foundations"],
            ].map(([icon, name]) =>
              h(
                "button",
                {
                  key: name,
                  className: "selection-item",
                  type: "button",
                  "aria-current": page === name ? "page" : undefined,
                  onClick: () => setPage(name),
                },
                h(Icon, { component: icon }),
                name,
              ),
            ),
          ),
        ),
        page === "Conversation" &&
          h(ConversationSidebar, {
            hostId,
            conversations,
            selectedId,
            onHost: setHostId,
            onConversation: (id) => setSelectedByHost((current) => ({ ...current, [hostId]: id })),
            onNew: newConversation,
          }),
      ),
      h(
        "main",
        { className: "study-body" },
        h(
          "header",
          { className: "study-header" },
          h("h1", null, page === "Conversation" ? "Chat" : page),
          h(Appearance, { value: appearance, setValue: setAppearance }),
        ),
        h(
          "div",
          { hidden: page !== "Conversation" },
          h(ChatPreview, {
            key: selectedId,
            conversation,
            update: updateConversation,
            composerPreferences,
            setComposerPreferences,
          }),
        ),
        h("div", { hidden: page !== "Components" }, h(Components, { appearance })),
        h("div", { hidden: page !== "Foundations" }, h(Foundations)),
      ),
    ),
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Design playground root is missing");
createRoot(container).render(h(App));
