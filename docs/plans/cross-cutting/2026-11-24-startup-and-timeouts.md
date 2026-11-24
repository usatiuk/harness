# Startup progress and configurable timeouts

Implementation and validation are recorded below.

## Cold-start audit before implementation

The host opens its database, initializes the user shell and sandbox, then starts enabled MCP servers **sequentially**. Each performs version negotiation, initialization and paginated tool discovery. Provider catalog bootstrap follows and has its own shared 10-second discovery budget. The background owner publishes its endpoint only after composition finishes. A warm connection skips that boot sequence.

In the pinned MCP SDK 2.3.1, Harness's 1-second `server/discover` probe is fatal on HTTP expiry. With stdio the SDK probes a disposable child and can try legacy initialization when the probe expires. A longer silent probe can therefore delay a legacy stdio server. The probe and its fallback need to fit within the per-server startup budget.

A loopback experiment through `McpRuntime.initialize()` used the repository's real HTTP fixture. The ordinary run discovered two tools in 78 ms. Delaying only the first HTTP response by 1.5 seconds produced zero tools and “MCP initialization failed” after 1,004 ms. An independent SDK check delayed replies by 1.4 seconds. Changing only the probe from one to five seconds restored both tools. The user's individual servers and ten-second launch have not been profiled.

| Owner                | Existing deadline and interaction                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP runtime          | 30 seconds shared across connection and discovery after transport preparation. Each tool call gets a separate hard-coded 30 seconds.                                    |
| Hosted MCP transport | The shared OAuth/HTTP fetch wrapper adds 30 seconds independently and masks the cause. Increasing the runtime limit alone cannot fix slow HTTP responses.               |
| Startup manager      | 20 seconds for a launched owner to publish discovery. Another manager also has a 20-second wait for the lifecycle lock. Both can expire during legitimate cold startup. |
| Desktop              | 20 seconds from native bridge admission through session initialization and identity lookup. Admission can precede host readiness.                                       |
| Shell                | 10 seconds for host shell environment capture on Unix. Container shell capture reuses the constant and has its own cleanup allowance.                                   |
| Approvals            | Human response and model review already have independent Settings controls, defaulting to 60 and 30 seconds.                                                            |
| Code Mode            | One second of cumulative interpreter execution, measured inside running slices. Time waiting for tools and approval is excluded.                                        |

Source entry points are [MCP runtime](../../../packages/mcp/src/index.ts), [HTTP wrapper](../../../packages/mcp/src/credentials.ts), [composition](../../../packages/server/src/index.ts), [owner publication](../../../packages/server/src/background.ts), [startup manager](../../../packages/connections/src/connect.ts), [desktop connection](../../../packages/desktop/src/hosts.ts) and [Code Mode evaluator](../../../packages/code-mode/src/evaluator.ts).

## Implementation and validation

- [x] Reproduce the original HTTP failure and exercise discovery against the stock SDK with a delayed first response. The regression also executes a held tool with its own short override and verifies exactly one invocation.
- [x] Implement finite defaults of 300 seconds for MCP startup/discovery, 900 seconds for tool execution, and 15 seconds for the stdio compatibility probe. Overrides live in the existing server editor's collapsed Timeouts section. The approved revision excludes unlimited MCP settings. The SDK remains stock. A runtime-owned HTTP dispatcher lets quiet tools use the configured deadline beyond Node fetch's idle limit.
- [x] Add host-side progress for shell, sandbox, MCP and provider discovery to the existing bridge. Retain one attempt per host in memory.
- [x] Report server and Node transfer counts using the release manifest or Node pin. Include received archive bytes, total archive bytes and measured transfer rate on the same progress channel. Extraction has its own stage.
- [x] Add finite host and desktop session startup limits. Expose shell, model discovery and Code Mode interpreter time under host defaults and preserve separate human/auto-review settings. Test saving unrelated settings after customizing host deadlines.
- [x] Windows packaged desktop held a real HTTP MCP startup beyond 20 seconds with stable controls, retained discovery timings, and displayed a cold Node download with percent and MiB/s. Additional native tests verified warm cache reuse and bridge shutdown before RPC initialization. Three browser tests passed, including a saved execution override reopened in Settings.
- [x] `npm run check` passed with three Vitest workers (2,122 passed, 83 skipped). Bootstrap tests and native desktop bridge tests passed. Windows WebView2 covered the packaged startup view. Live SSH/WSL release downloads and macOS/Linux desktop rendering were not exercised.

MCP startup remains sequential. Connecting in parallel would need bounded child startup, draining failed connections, and deterministic admission to preserve tool collision behavior.
