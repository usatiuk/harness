# JVM libraries for one streaming model call

Research on 2026-11-14. The target is the same seam as
[Pi AI](2026-11-12-pi-durable.md#the-model-call-library-underneath).
Supply messages and tool schemas, stream progress, and get finalized model
output. The caller runs tools, chooses when to sample again, and supplies
storage and compaction. This comparison uses official APIs and upstream
reports. No providers or SDKs were run.

## Java

**LangChain4j** exposes `StreamingChatModel.chat(ChatRequest, handler)`.
The request takes messages and `ToolSpecification` values. The callbacks
deliver incremental text, thinking, and tool arguments, followed by a
final `ChatResponse`. The caller can execute requests from the resulting
`AiMessage`, attach their results, and make the next call. A
`Flow.Publisher` interface also exists. [Manual tool calling](https://docs.langchain4j.dev/tutorials/tools/#using-streamingchatmodel),
[response streaming](https://docs.langchain4j.dev/tutorials/response-streaming/).

The message API includes `PdfFileContent`, and the Anthropic adapter
documents PDF input and preservation of thinking signatures. The OpenAI
Responses adapter can request encrypted reasoning and re-emits it when the
returned `AiMessage` is part of the next request. Gemini has separate
settings depending on the integration. Persist the full message attributes
for these paths. The most recent release tag verified through GitHub was
`1.23.0`. Check the selected modules against the release when using a
versionless documentation site. [Anthropic](https://docs.langchain4j.dev/integrations/language-models/anthropic/),
[OpenAI](https://docs.langchain4j.dev/integrations/language-models/open-ai/#encrypted-reasoning-keeping-reasoning-in-context),
[Google Gen AI](https://docs.langchain4j.dev/integrations/language-models/google-genai/).

**Spring AI 2.x** also exposes low-level `ChatModel.call` and
`StreamingChatModel.stream`. The automatic loop sits in a `ChatClient`
advisor. Direct model calls leave that sequencing to the caller.
[Spring AI tool calling](https://docs.spring.io/spring-ai/reference/api/tools.html).

## Kotlin

**JetBrains Koog** exposes `LLMClient.executeStreaming(prompt, model, tools)`
as `Flow<StreamFrame>`. The tool parameter is a list of `ToolDescriptor`
values. The frames include text, reasoning, and tool deltas and completions,
plus terminal metadata. Helpers convert completed frames to messages.
The prompt DSL has image, document, audio, and video parts, with actual
support governed by the selected adapter and model. There is also a Java
publisher interface. [Client API](https://api.koog.ai/prompt/prompt-executor/prompt-executor-clients/ai.koog.prompt.executor.clients/-l-l-m-client/index.html),
[stream frames](https://docs.koog.ai/streaming-api/),
[attachments](https://docs.koog.ai/prompts/prompt-creation/multimodal-content/).

The latest release tag verified through GitHub was `1.3.0`. An open issue
documents that release dropping streamed OpenAI Responses reasoning items
that have encrypted content and no summary. The proposed fix was open and
unmerged when checked. This affects caller-owned stateless continuation
even if the application faithfully saves what the stream returns.
[Report with reproduction](https://github.com/JetBrains/koog/issues/2287),
[proposed fix](https://github.com/JetBrains/koog/pull/2291).

## Scala

**LLM4S** exposes `LLMClient.streamComplete(conversation, options, onChunk)`.
The callback receives deltas and the method returns a complete `Completion`.
The ZIO wrapper also offers a `ZStream` path. The provider guide documents
round-tripping Anthropic, Gemini, and several other providers' reasoning
payloads. Its standard OpenAI adapter uses Chat Completions, so it lacks
the OpenAI Responses encrypted-reasoning path described above. Version
`0.5.1` introduces text, image, and document parts. Media support depends
on the adapter. A Scala app can also use the Java model clients directly.
[Streaming example](https://llm4s.org/examples/cookbook/streaming.html),
[ZIO integration](https://llm4s.org/guide/zio),
[provider behavior](https://llm4s.org/guide/providers),
[multimodal API change](https://llm4s.org/reference/migration).

## Small dependencies to start with

- **Kotlin or Java with several providers:** Koog's standalone prompt client
  modules share the `LLMClient` API. Use the clients directly with your
  messages and tool descriptors. The streaming reasoning issue above still
  applies to the affected OpenAI adapter.
  [Direct prompt execution](https://docs.koog.ai/prompts/#running-prompts).
- **Scala:** sttp-ai's provider clients expose the native request and response
  types for OpenAI, Claude, and Gemini, with separate streaming integrations.
  That keeps the client layer small. The application still maps between
  provider message formats if it wants a common transcript.
  [sttp-ai provider clients](https://sttp-ai.softwaremill.com/index.html).
- **One provider on the JVM:** use the provider SDK directly. The OpenAI Java
  SDK, for example, exposes the Responses stream and an accumulator that
  builds the final response for the caller.
  [OpenAI Java SDK streaming](https://github.com/openai/openai-java#usage-with-streaming).

For any candidate, the useful continuation check is to stream a request with
an attachment and a tool call, serialize the final response, then use the
reloaded response and tool result in the next call.

## Opaque message round-trip

The desired API lets an application store a library-owned message as opaque,
versioned data and feed it back into a later request. The application chooses
and orders the messages. It can use supported constructors for user input
and tool results and consume separate text and tool-call events. The library
owns the message codec, provider metadata, and conversion for the target
model. When the target cannot accept the input, the library should report
which capability is unsupported.

Pi AI documents serialization and cross-provider reuse of its typed messages.
Koog is the closest JVM candidate here. It accepts its own message objects in
the prompt and converts completed streaming frames back into those objects.
The reported encrypted-only reasoning loss shows why the full contract needs
a round-trip test for each adapter. sttp-ai exposes native provider types, so
the caller would still own cross-provider message conversion.
[Pi AI serialization](https://github.com/earendil-works/pi/tree/main/packages/ai#context-serialization),
[Koog prompt builder](https://api.koog.ai/prompt/prompt-model/ai.koog.prompt.dsl/-prompt-builder/message.html),
[Koog stream conversion](https://docs.koog.ai/streaming-api/#converting-frames-to-messageresponse),
[sttp-ai](https://sttp-ai.softwaremill.com/index.html).

## Wider JVM, TypeScript, and Rust search

Follow-up on 2026-11-17. The comparison separates storing a message and
reusing it with the same adapter from sending it to a different provider.
Both should use the message returned by the library. The second operation
also needs rules for provider-bound state and unsupported media.

- **Rust, `genai`.** `ChatMessage` supports Serde serialization and
  deserialization. The stream capture has
  `into_assistant_message_for_tool_use()`, which produces a reusable message
  and preserves thought signature ordering. The message type supports binary
  parts, including PDFs where the adapter supports them. This is a close
  native Rust fit. Cross-provider conversion of all signed parts, and replay
  after compaction, remain unverified.
  [ChatMessage](https://docs.rs/genai/0.7.3/genai/chat/struct.ChatMessage.html),
  [stream capture](https://github.com/jeremychone/rust-genai/blob/main/docs/for-llm/api-reference-for-llm.md),
  [binary parts](https://docs.rs/genai/0.7.3/genai/chat/enum.ContentPart.html).
- **TypeScript and Rust, `hoangvvo/llm-sdk`.** Its one-call model interface
  has a shared JSON schema across languages, with file, reasoning, tool call,
  and tool result parts. The final response contains content parts that can
  be put in an assistant message. At `14162187ec23807a75390c528c3b1876afeed662`
  the common reasoning part has a signature and optional ID but no origin
  field. The JavaScript adapter conversions read the same signature field
  as Anthropic signed or redacted thinking, Gemini thought signatures, and
  OpenAI encrypted content. That is a concrete gap for switching providers
  with signed history. The source inspection does not establish runtime
  behavior for every route or the Rust adapters.
  [Shared API](https://github.com/hoangvvo/llm-sdk#llm-sdks),
  [schema](https://github.com/hoangvvo/llm-sdk/blob/14162187ec23807a75390c528c3b1876afeed662/schema/sdk.json),
  [Anthropic](https://github.com/hoangvvo/llm-sdk/blob/14162187ec23807a75390c528c3b1876afeed662/sdk-js/src/anthropic/anthropic.ts#L662-L677),
  [Gemini](https://github.com/hoangvvo/llm-sdk/blob/14162187ec23807a75390c528c3b1876afeed662/sdk-js/src/google/google.ts#L417-L440),
  [OpenAI](https://github.com/hoangvvo/llm-sdk/blob/14162187ec23807a75390c528c3b1876afeed662/sdk-js/src/openai/openai.ts#L368-L382).
- **TypeScript, Vercel AI SDK.** `streamText().responseMessages` returns
  model messages containing assistant output and requested tool calls.
  Persist those messages, including per-part provider options. Supply tool
  results separately when the app executes them. The SDK's UI messages have
  a different purpose and do not support provider options directly. This is
  a close fit for attachments and caller-owned sequencing.
  [Final response messages](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text),
  [model message options](https://ai-sdk.dev/docs/foundations/prompts#provider-options).

Pi AI still has the clearest documented treatment of foreign reasoning in
this comparison, with text and images in its common chat input. For a
native JVM library, Koog's standalone prompt clients remain the closest
match found, subject to the encrypted-only streaming issue. These are
source and documentation findings. No live round-trip was run.
