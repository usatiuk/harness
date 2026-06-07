import { useEffect, useReducer, useRef, useState, type ReactElement } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { ConfirmInput, Spinner, TextInput } from "@inkjs/ui";
import type { Conversation, HarnessEvent, Item } from "@harness/protocol";
import type { HarnessService } from "@harness/service";
import { init, reduce, type Cell, type State } from "./transcript-reducer.ts";
import { runCommand, type CommandContext } from "./commands.ts";
import { CellView, cellKey } from "./cells.tsx";

const INSTRUCTIONS_PLACEHOLDER = "type a message…   (> queue · ! interrupt · /help · Esc abort)";

export interface AppProps {
  service: HarnessService;
  conversation: Conversation;
  initialItems: Item[];
  model: string;
  cwd: string;
  /** Switch conversation (id resumes directly; omitted opens the picker). */
  onResume: (id?: string) => void;
}

type Action =
  | { type: "event"; event: HarnessEvent }
  | { type: "clear" }
  | { type: "note"; id: string; text: string };

/** Wraps the pure reducer with local-only actions (clear / note) the event stream can't express. */
function appReduce(state: State, action: Action): State {
  switch (action.type) {
    case "event":
      return reduce(state, action.event);
    case "clear":
      return { ...state, cells: [] };
    case "note":
      return {
        ...state,
        cells: [...state.cells, { kind: "note", id: action.id, text: action.text }],
      };
  }
}

const renderCell = (cell: Cell): ReactElement => (
  <Box key={cellKey(cell)}>
    <CellView cell={cell} />
  </Box>
);

export function App({
  service,
  conversation,
  initialItems,
  model,
  cwd,
  onResume,
}: AppProps): ReactElement {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(appReduce, initialItems, init);
  const noteId = useRef(0);
  const busy = state.turn.status === "running";
  const pending = state.pending;

  useEffect(() => service.subscribe((event) => dispatch({ type: "event", event })), [service]);

  // Esc interrupts a running turn (aborting also cancels any parked request).
  useInput((_input, key) => {
    if (key.escape && busy) void service.deliver(conversation.id, "", "interrupt");
  });

  const ctx: CommandContext = {
    service,
    conversationId: conversation.id,
    note: (text) => dispatch({ type: "note", id: `note-${++noteId.current}`, text }),
    clear: () => dispatch({ type: "clear" }),
    resume: onResume,
    exit,
  };

  const submit = (raw: string): void => {
    const line = raw.trim();
    if (line === "") return;
    if (line.startsWith("/")) {
      if (!runCommand(line, ctx)) ctx.note(`unknown command: ${line}`);
      return;
    }
    if (line.startsWith(">")) {
      void service.deliver(conversation.id, line.slice(1).trim(), "queue");
      return;
    }
    if (line.startsWith("!")) {
      void service.deliver(conversation.id, line.slice(1).trim(), "interrupt");
      return;
    }
    void service.deliver(conversation.id, line, busy ? "steer" : "send");
  };

  // Finalized cells (longest immutable prefix) print once to native scrollback via
  // <Static>; only the live tail repaints. The prefix only ever grows, so Static is safe.
  const cut = firstLiveIndex(state.cells);
  const done = state.cells.slice(0, cut);
  const live = state.cells.slice(cut);

  return (
    <Box flexDirection="column">
      <Static items={done}>{renderCell}</Static>
      {live.map(renderCell)}
      {pending ? (
        <Box>
          <Text color="magenta">{`❓ ${pending.summary} `}</Text>
          <ConfirmInput
            onConfirm={() =>
              service.respond(conversation.id, pending.requestId, { decision: "allow" })
            }
            onCancel={() =>
              service.respond(conversation.id, pending.requestId, { decision: "deny" })
            }
          />
        </Box>
      ) : (
        <>
          <StatusBar busy={busy} model={model} cwd={cwd} />
          <Composer onSubmit={submit} />
        </>
      )}
    </Box>
  );
}

function StatusBar({
  busy,
  model,
  cwd,
}: {
  busy: boolean;
  model: string;
  cwd: string;
}): ReactElement {
  return (
    <Box>
      {busy ? <Spinner label="working" /> : <Text color="green">●</Text>}
      <Text dimColor>{`  ${model} · ${cwd}`}</Text>
    </Box>
  );
}

function Composer({ onSubmit }: { onSubmit: (value: string) => void }): ReactElement {
  // Remount on each submit (key bump) to clear the uncontrolled input.
  const [gen, setGen] = useState(0);
  return (
    <Box>
      <Text color="cyan">{"› "}</Text>
      <TextInput
        key={gen}
        placeholder={INSTRUCTIONS_PLACEHOLDER}
        onSubmit={(value) => {
          onSubmit(value);
          setGen((g) => g + 1);
        }}
      />
    </Box>
  );
}

const isLive = (c: Cell): boolean => {
  if (c.kind === "assistant" || c.kind === "reasoning") return c.streaming;
  if (c.kind === "tool") return c.status === undefined;
  return false;
};

const firstLiveIndex = (cells: Cell[]): number => {
  const i = cells.findIndex(isLive);
  return i === -1 ? cells.length : i;
};
