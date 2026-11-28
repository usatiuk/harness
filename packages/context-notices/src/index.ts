import type {
  AgentRequestContext,
  ContentBlock,
  Plugin,
  PluginContextItem,
} from "@harness/protocol";

const id = "context-notices";
const minute = 60_000;

// Each record describes only what the model has actually been told in this window.
type Snapshot = {
  provider: string;
  model: string;
  clock: { at: number; day: string; offset: number };
  warned: boolean;
};

function reconcile(
  { model, capacity }: AgentRequestContext,
  previous?: Snapshot,
): { content: ContentBlock[]; data: Snapshot } {
  const now = new Date();
  const at = now.getTime();
  const offset = -now.getTimezoneOffset();
  // Shift to local wall time before formatting so the date and UTC offset refer to the same instant.
  const local = new Date(at + offset * minute).toISOString();
  const day = local.slice(0, 10);
  const dateChanged = !previous || day !== previous.clock.day || offset !== previous.clock.offset;
  const clockChanged = dateChanged || Math.abs(at - previous.clock.at) >= 10 * minute;
  const lines: string[] = [];
  if (!previous || previous.provider !== model.provider || previous.model !== model.model) {
    lines.push(`Current model: ${model.provider}/${model.model}.`);
  }
  if (clockChanged) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const abs = Math.abs(offset);
    const time = `${local.slice(11, 16)} UTC${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    lines.push(dateChanged ? `Local date and time: ${day} ${time}` : `Current time: ${time}`);
  }
  const warn =
    !previous?.warned && capacity && capacity.estimatedTokens >= 0.9 * capacity.thresholdTokens;
  if (warn) {
    lines.push(
      `Compaction soon: estimated input is at ${Math.floor((100 * capacity.estimatedTokens) / capacity.thresholdTokens)}% of the compaction threshold.`,
    );
  }
  return {
    content: lines.length ? [{ type: "text", text: lines.join("\n") }] : [],
    data: {
      provider: model.provider,
      model: model.model,
      clock: clockChanged ? { at, day, offset } : previous.clock,
      warned: Boolean(warn || previous?.warned),
    },
  };
}

export const contextNoticesPlugin = {
  id,
  systemContext(model) {
    return reconcile({ model });
  },
  async contextItems(ctx, boundary): Promise<PluginContextItem[]> {
    if (boundary.type !== "agentRequest") return [];
    const latest = (await ctx.active()).findLast(
      (item) => item.type === "plugin_data" && item.plugin === id,
    );
    // Missing on legacy windows; seed them at the first ordinary agent request.
    const { content, data } = reconcile(
      boundary,
      latest?.type === "plugin_data" ? (latest.data as Snapshot) : undefined,
    );
    return content.length ? [{ type: "context", key: id, content, data }] : [];
  },
} satisfies Plugin;
