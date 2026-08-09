# Chat reasoning round-trip

**Status:** Complete — implemented and validated 2026-08-09.

## Defect

Harness stores reasoning, assistant text, and tool calls as separate canonical
items. The first chat implementation rendered them as separate assistant
messages, but DeepSeek thinking-mode continuation requires the reasoning content
on the same native assistant message as that generation's tool calls.

## Decision

`buildChatParams` accumulates assistant-side items between user-side boundaries
into one native message:

```text
{ role: assistant, content, reasoning_content, tool_calls }
```

The reconstruction is position-independent within the generation. A reasoning-
only generation flushes as an assistant message with `content: null`. User
messages, tool results, compaction, and context boundaries close the generation;
context itself is hoisted into the leading system message.

Inbound reasoning is finalized before following text/tool output so the durable
item order remains suitable for display. If a backend later emits additional
reasoning after finalization, the transport fails rather than silently losing
content that could not be replayed.

## Evidence

Request tests cover reasoning with text, multiple calls, tool-result boundaries,
position independence, compaction/context boundaries, and standalone reasoning.
Stream tests cover mixed deltas, the finalization guard, malformed calls, and
terminal failure semantics. The opt-in OpenCode test carries the previously
failing reasoning + text + declared tool-call/result continuation shape against
DeepSeek; it requires `OPENCODE_API_KEY` and is not part of normal CI.
