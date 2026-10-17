import {
  ContextWindowExceededError,
  textOf,
  type ContentBlock,
  type CompactionStrategy,
  type Item,
  type NewContextBuild,
  type ToolMiddleware,
} from "@harness/protocol";

const COMPACTION_PROMPT = `We are compacting the conversation context before continuing the task.
Return a self-contained summary that preserves the current objective, user requirements and
constraints, decisions, completed work, relevant files and symbols, errors, and pending next steps.`;

const CONTINUING_COMPACTION_PROMPT = `${COMPACTION_PROMPT}
First write the complete, non-empty summary as visible assistant text. Reasoning or tool calls
alone are not a summary. The summary must stand on its own without any later tool results.
Only after writing the summary may you make tool calls that immediately continue the task.
If you make tool calls, your response must still include the complete summary text.`;

const MANUAL_COMPACTION_PROMPT = `${COMPACTION_PROMPT}
Return only the non-empty summary. Do not continue the task or call tools.`;

const FALLBACK_MAX_CHARS = 24_000;

/** The default when no plugin contributes a strategy: never fold. */
export const noCompaction: CompactionStrategy = {
  async compact() {
    return null;
  },
};

/**
 * Bounds a chain at its latest compaction: the summary stands for everything before
 * it, so context starts there. Context-build and the compaction pass both slice
 * through here, so they agree on the window by construction.
 */
export function compactedWindow(items: Item[]): Item[] {
  const i = items.findLastIndex((item) => item.type === "compaction");
  return i === -1 ? items : items.slice(i);
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
        instructions: input.build.instructions,
        items: input.build.items,
        tools: input.build.tools,
        prompt: input.reason === "manual" ? MANUAL_COMPACTION_PROMPT : CONTINUING_COMPACTION_PROMPT,
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
      case "provider_output":
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
    instructions: estimatedContent(build.instructions),
    tools: build.tools,
    items: build.items.map(({ item, ...rest }) => ({
      ...rest,
      item: "content" in item ? { ...item, content: estimatedContent(item.content) } : item,
    })),
    ...(build.providerOptions !== undefined ? { providerOptions: build.providerOptions } : {}),
    ...(build.prompt ? { prompt: build.prompt } : {}),
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
      if (ctx.service("execution")) return result; // a file host exists ⇒ defer to the output-bounding policy
      const forModel = result.forModel.map((block) =>
        block.type === "text" && block.text.length > maxChars
          ? { type: "text" as const, text: `${block.text.slice(0, maxChars)}…[truncated]` }
          : block,
      );
      return { ...result, forModel };
    },
  };
}
