import {
  ContextWindowExceededError,
  textOf,
  inlineMessage,
  type ContentBlock,
  type CompactionStrategy,
  type Item,
  type NewContextBuild,
  type ToolMiddleware,
} from "@harness/protocol";

const COMPACTION_PROMPT = `Write a self-contained handoff for the agent that will continue this session. After compaction, the agent will see this handoff instead of the messages exchanged in this session so far. Assume it knows nothing you learned here unless you put it in the handoff.

State what the user wants, including their instructions, preferences, constraints, and what they have or have not authorized. Explain what was decided and why, what changed and where, and what was verified. For unfinished work, describe what remains and give the next concrete steps (including the plan, milestones, or roadmap, if any, along with current progress and dependencies).

The user may start a different task in this session. Preserve reusable project knowledge even when the current task no longer needs it: user preferences and project conventions, environment and setup details, useful commands and file or symbol names, and tips or pitfalls learned along the way.`;

const CONTINUING_COMPACTION_PROMPT = `${COMPACTION_PROMPT}
First write the complete, non-empty handoff as visible assistant text. It must stand on its own without any later tool results. Only then may you make tool calls that immediately continue the session. Reasoning or tool calls alone do not count as a handoff.`;

const MANUAL_COMPACTION_PROMPT = `${COMPACTION_PROMPT}
Return only the non-empty handoff. Do not continue the session or call tools.`;

const FALLBACK_MAX_CHARS = 24_000;

/** The default when no plugin contributes a strategy: never fold. */
export const noCompaction: CompactionStrategy = {
  async compact() {
    return null;
  },
};

/** Select the latest window on this branch, including its refreshed opening items. */
export function compactedWindow(items: Item[]): Item[] {
  const fold = items.findLast((item) => item.type === "compaction");
  if (!fold) return items;
  const start = items.findIndex((item) => item.id === fold.windowStart);
  if (start < 0) throw new Error(`missing compaction window start: ${fold.windowStart}`);
  return items.slice(start);
}

/** Same-model compaction used by the CLI; alternative compositions can contribute another strategy. */
export const modelCompaction: CompactionStrategy = {
  async compact(input) {
    if (input.build.items.length === 0) return null;
    if (input.outputTokenLimit !== undefined && input.outputTokenLimit < 1) {
      throw new ContextWindowExceededError(
        "insufficient context capacity for model-backed compaction",
      );
    }
    const result = await input.models.invoke(
      {
        items: [
          ...input.build.items,
          inlineMessage(
            "user",
            input.reason === "manual" ? MANUAL_COMPACTION_PROMPT : CONTINUING_COMPACTION_PROMPT,
          ),
        ],
        tools: input.build.tools,
        ...(input.reason === "manual" ? { toolChoice: "none" as const } : {}),
        ...(input.outputTokenLimit !== undefined
          ? { maxOutputTokens: input.outputTokenLimit }
          : {}),
      },
      { purpose: "compaction", signal: input.signal },
    );
    const outputItems = result.outputItems.filter(
      (item) => item.type !== "message" && item.type !== "provider_output",
    );
    return { content: result.content, ...(outputItems.length ? { outputItems } : {}) };
  },
};

/** Bounded, provider-independent escape hatch when automatic model summarization cannot run. */
export function fallbackCompaction(build: NewContextBuild): ContentBlock[] {
  const rendered = build.items.map(({ item }) => {
    switch (item.type) {
      case "message":
        return `${item.role}: ${textOf(item.content)}`;
      case "reasoning":
        return "";
      case "tool_call":
        return `tool call ${item.name}: ${JSON.stringify(item.args)}`;
      case "tool_result":
        return `tool result ${item.callId} (${item.status}): ${textOf(item.content)}`;
      case "compaction":
        return `prior summary: ${textOf(item.content)}`;
      case "context":
        return `context: ${textOf(item.content)}`;
    }
  });
  const kept: string[] = [];
  let remaining = FALLBACK_MAX_CHARS;
  for (let i = rendered.length - 1; i >= 0 && remaining > 0; i--) {
    const text = rendered[i];
    if (!text) continue;
    const piece = text.length <= remaining ? text : text.slice(text.length - remaining);
    kept.push(piece);
    remaining -= piece.length + 1;
  }
  kept.reverse();
  return [
    {
      type: "text",
      text: [
        "Earlier context was compacted with a deterministic fallback because automatic summarization failed.",
        "The most recent bounded context follows:",
        ...kept,
      ].join("\n"),
    },
  ];
}

/** Coarse provider-neutral estimate used between authoritative provider usage checkpoints. */
export function estimateContextTokens(build: NewContextBuild): number {
  let imageTokens = 0;
  const estimatedContent = (content: ContentBlock[]) =>
    content.map((block) => {
      if (block.type !== "image") return block;
      // Vision cost is model-specific; base64 length is not a text-token estimate.
      // Provider accounting and context-overflow handling remain authoritative.
      imageTokens += 4096;
      return { type: block.type, mediaType: block.mediaType };
    });
  const serialized = JSON.stringify({
    tools: build.tools,
    items: build.items.map(({ item, ...rest }) => ({
      ...rest,
      item: "content" in item ? { ...item, content: estimatedContent(item.content) } : item,
    })),
    ...(build.providerOptions !== undefined ? { providerOptions: build.providerOptions } : {}),
  });
  let ascii = 0;
  let nonAsciiCodeUnits = 0;
  for (const character of serialized) {
    if (character.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAsciiCodeUnits += character.length;
  }
  // English/JSON averages several characters per token; non-ASCII text is often
  // much denser, so count its UTF-16 units individually instead of dividing by four.
  return imageTokens + Math.ceil(ascii / 4 + nonAsciiCodeUnits);
}

/**
 * Caps each text block of the tool's result, but only when there is no execution backend to spill
 * to a file — otherwise the output-bounding middleware preserves the full output, so this defers.
 */
export function truncateMiddleware(maxChars = 10_000): ToolMiddleware {
  return {
    id: "truncate",
    async wrap(call, ctx, next) {
      const result = await next(call);
      // Nested results go to the guest unprojected; the engine bounds the recorded copy.
      if (call.parentCallId || ctx.service("execution")) return result;
      const forModel = result.forModel.map((block) =>
        block.type === "text" && block.text.length > maxChars
          ? { type: "text" as const, text: `${block.text.slice(0, maxChars)}…[truncated]` }
          : block,
      );
      return { ...result, forModel };
    },
  };
}
