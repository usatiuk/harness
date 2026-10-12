import { useEffect, useRef, useState } from "react";
import type { HarnessClient } from "@harness/client";
import { jsonValueSchema } from "@harness/protocol";
import { toolPermissionSchema, type ToolPermission } from "@harness/approval/client";
import {
  mcpConfigSchema,
  mcpSettingsGet,
  mcpSettingsSet,
  mcpToolsList,
  mcpTest,
  mcpCredentialSet,
  mcpCredentialDelete,
  mcpAuthStart,
  mcpAuthComplete,
  mcpAuthCancel,
  mcpAuthLogout,
  type McpSettingsData,
  type McpServerConfig,
  type McpValueSource,
  type McpToolInfo,
} from "@harness/mcp/client";
import { Button, Input, Select, SelectItem, Textarea } from "../ui.tsx";

function PermissionOptions({ inherit = false }: { inherit?: boolean }) {
  return (
    <>
      {inherit && <SelectItem value="">Inherit</SelectItem>}
      {toolPermissionSchema.options.map((value) => (
        <SelectItem key={value} value={value}>
          {value === "ask-human" ? "Ask human" : value[0]!.toUpperCase() + value.slice(1)}
        </SelectItem>
      ))}
    </>
  );
}
function Sources({
  values,
  change,
  header,
}: {
  values: Record<string, McpValueSource>;
  change: (values: Record<string, McpValueSource>) => void;
  header: boolean;
}) {
  const update = (name: string, value: McpValueSource) => change({ ...values, [name]: value });
  return (
    <fieldset>
      <legend>{header ? "Headers" : "Environment variables"}</legend>
      {Object.entries(values).map(([name, source]) => (
        <div className="form-grid" key={name}>
          <label>
            Name
            <Input
              defaultValue={name}
              aria-label="Value name"
              onBlur={(event) => {
                const key = event.currentTarget.value.trim();
                if (!key || key === name || key in values) return;
                const next = { ...values };
                delete next[name];
                next[key] = source;
                change(next);
              }}
            />
          </label>
          <label>
            Source
            <Select
              value={source.type}
              onValueChange={(next) => {
                const type = next;
                update(
                  name,
                  type === "literal"
                    ? { type, value: "" }
                    : type === "env"
                      ? { type, name: "" }
                      : { type: "secret", slot: "" },
                );
              }}
            >
              <SelectItem value="literal">Plaintext value</SelectItem>
              <SelectItem value="env">Host environment</SelectItem>
              <SelectItem value="secret">Stored credential slot</SelectItem>
            </Select>
          </label>
          <label>
            {source.type === "literal"
              ? "Plaintext value"
              : source.type === "env"
                ? "Host variable name"
                : "Credential slot"}
            <Input
              value={
                source.type === "literal"
                  ? source.value
                  : source.type === "env"
                    ? source.name
                    : source.slot
              }
              onChange={(event) =>
                update(
                  name,
                  source.type === "literal"
                    ? { ...source, value: event.currentTarget.value }
                    : source.type === "env"
                      ? { ...source, name: event.currentTarget.value }
                      : { ...source, slot: event.currentTarget.value },
                )
              }
            />
          </label>
          <Button
            onClick={() => {
              const next = { ...values };
              delete next[name];
              change(next);
            }}
          >
            Remove value
          </Button>
        </div>
      ))}
      <Button
        onClick={() => {
          let key = header ? "X-Header" : "VARIABLE";
          while (key in values) key += "_";
          update(key, { type: "env", name: "" });
        }}
      >
        Add value
      </Button>
    </fieldset>
  );
}

function CredentialSource({
  label,
  value,
  change,
  optional = false,
}: {
  label: string;
  value: Exclude<McpValueSource, { type: "literal" }> | undefined;
  change: (value: Exclude<McpValueSource, { type: "literal" }> | undefined) => void;
  optional?: boolean;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      <label>
        Source
        <Select
          aria-label="Source"
          value={value?.type ?? ""}
          onValueChange={(next) =>
            change(
              next === "env"
                ? { type: "env", name: "" }
                : next === "secret"
                  ? { type: "secret", slot: "api-key" }
                  : undefined,
            )
          }
        >
          {optional && <SelectItem value="">None</SelectItem>}
          <SelectItem value="env">Host environment</SelectItem>
          <SelectItem value="secret">Stored credential slot</SelectItem>
        </Select>
      </label>
      {value && (
        <label>
          {value.type === "env" ? "Host variable name" : "Credential slot"}
          <Input
            value={value.type === "env" ? value.name : value.slot}
            onChange={(event) =>
              change(
                value.type === "env"
                  ? { ...value, name: event.currentTarget.value }
                  : { ...value, slot: event.currentTarget.value },
              )
            }
          />
        </label>
      )}
    </fieldset>
  );
}

export function McpSettings({
  client,
  openUrl,
  restart,
}: {
  client: HarnessClient;
  openUrl: (url: string) => Promise<void>;
  restart: () => Promise<void>;
}) {
  const [data, setData] = useState<McpSettingsData>();
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [id, setId] = useState("");
  const [originalId, setOriginalId] = useState<string>();
  const [server, setServer] = useState<McpServerConfig>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [slot, setSlot] = useState("api-key"),
    [secret, setSecret] = useState("");
  const [attempt, setAttempt] = useState<{
    attemptId: string;
    serverId: string;
    url: string;
    redirectUrl: string;
  }>();
  const owner = useRef<{ client: HarnessClient; attemptId?: string } | undefined>(undefined);
  const [callback, setCallback] = useState("");
  const [toolName, setToolName] = useState("");
  const [toolPermission, setToolPermission] = useState<ToolPermission>("ask");
  const config = data ? mcpConfigSchema.parse(data.config) : undefined;
  const refresh = async () => {
    const [settings, catalog] = await Promise.all([
      client.peer.request(mcpSettingsGet, {}),
      client.peer.request(mcpToolsList, {}),
    ]);
    setData(settings);
    setTools(catalog);
    if (
      attempt &&
      !settings.active.some((entry) => entry.id === attempt.serverId && entry.signingIn)
    ) {
      const mounted = owner.current;
      if (mounted?.attemptId) {
        await mounted.client.peer.request(mcpAuthCancel, { attemptId: mounted.attemptId });
        delete mounted.attemptId;
      }
      setAttempt(undefined);
    }
  };
  useEffect(() => {
    const mounted: { client: HarnessClient; attemptId?: string } = { client };
    owner.current = mounted;
    let live = true;
    void Promise.all([
      client.peer.request(mcpSettingsGet, {}),
      client.peer.request(mcpToolsList, {}),
    ]).then(
      ([settings, catalog]) => {
        if (live) {
          setData(settings);
          setTools(catalog);
        }
      },
      () => {
        if (live) setNotice("Unable to read MCP settings");
      },
    );
    return () => {
      live = false;
      if (owner.current === mounted) owner.current = undefined;
      if (mounted.attemptId)
        void client.peer.request(mcpAuthCancel, { attemptId: mounted.attemptId }).catch(() => {});
    };
  }, [client]);
  const run = (operation: () => Promise<void>) => {
    setBusy(true);
    setNotice(undefined);
    void operation()
      .catch((cause: unknown) =>
        setNotice(cause instanceof Error ? cause.message : "MCP request failed"),
      )
      .finally(() => setBusy(false));
  };
  const save = async (next = config) => {
    if (!next) return;
    await client.peer.request(mcpSettingsSet, {
      config: jsonValueSchema.parse(mcpConfigSchema.parse(next)),
    });
    await refresh();
    setNotice("Saved. Restart the server to activate changes.");
  };
  const update = (next: McpServerConfig) => setServer(next);
  if (!config) return <p>{notice ?? "Reading MCP settings…"}</p>;
  const status = data!.active.find((entry) => entry.id === id);
  return (
    <div className="form-grid">
      <p>
        Servers and credentials belong to this host. Enabling a server uses its read-only
        declarations under your configured rules. Changes require a server restart.
      </p>
      <p className="muted">
        Credential backend: {data!.credentialBackend ?? "selected on first credential write"}
      </p>
      <fieldset>
        <legend>MCP defaults</legend>
        {(["readOnly", "other"] as const).map((category) => (
          <label key={category}>
            {category === "readOnly" ? "Read-only tools" : "Other or unknown tools"}
            <Select
              value={config.defaults[category]}
              onValueChange={(next) =>
                run(() =>
                  save({
                    ...config,
                    defaults: {
                      ...config.defaults,
                      [category]: toolPermissionSchema.parse(next),
                    },
                  }),
                )
              }
            >
              <PermissionOptions />
            </Select>
          </label>
        ))}
      </fieldset>
      <label>
        Server
        <Select
          value={originalId ?? ""}
          onValueChange={(next) => {
            const key = next;
            setOriginalId(key || undefined);
            setId(key);
            setServer(key ? structuredClone(config.servers[key]) : undefined);
            setSecret("");
          }}
        >
          <SelectItem value="">Select a server</SelectItem>
          {Object.keys(config.servers).map((key) => (
            <SelectItem key={key} value={key}>
              {key}
            </SelectItem>
          ))}
        </Select>
      </label>
      <Button
        onClick={() => {
          setSecret("");
          setOriginalId(undefined);
          setId("");
          setServer({
            enabled: true,
            transport: { type: "stdio", executable: "", args: [], env: {} },
            defaults: {},
            tools: {},
          });
        }}
      >
        Add server
      </Button>
      {server && (
        <>
          <label>
            Server ID
            <Input
              value={id}
              readOnly={!!originalId}
              onChange={(event) => setId(event.currentTarget.value)}
            />
          </label>
          <label>
            Enabled
            <input
              type="checkbox"
              checked={server.enabled}
              onChange={(event) => update({ ...server, enabled: event.currentTarget.checked })}
            />
          </label>
          <label>
            Transport
            <Select
              aria-label="Transport"
              value={server.transport.type}
              onValueChange={(next) =>
                update({
                  ...server,
                  transport:
                    next === "stdio"
                      ? { type: "stdio", executable: "", args: [], env: {} }
                      : { type: "http", url: "https://", headers: {}, auth: { type: "none" } },
                })
              }
            >
              <SelectItem value="stdio">Local stdio</SelectItem>
              <SelectItem value="http">Hosted HTTP</SelectItem>
            </Select>
          </label>
          {server.transport.type === "stdio" ? (
            <>
              <label>
                Executable
                <Input
                  value={server.transport.executable}
                  onChange={(event) => {
                    if (server.transport.type === "stdio")
                      update({
                        ...server,
                        transport: { ...server.transport, executable: event.currentTarget.value },
                      });
                  }}
                />
              </label>
              <label>
                Arguments (one per line)
                <Textarea
                  value={server.transport.args.join("\n")}
                  onChange={(event) => {
                    if (server.transport.type === "stdio")
                      update({
                        ...server,
                        transport: {
                          ...server.transport,
                          args: event.currentTarget.value
                            ? event.currentTarget.value.split("\n")
                            : [],
                        },
                      });
                  }}
                />
              </label>
              <label>
                Working directory
                <Input
                  value={server.transport.cwd ?? ""}
                  onChange={(event) => {
                    if (server.transport.type === "stdio") {
                      const transport = { ...server.transport };
                      delete transport.cwd;
                      update({
                        ...server,
                        transport: {
                          ...transport,
                          ...(event.currentTarget.value ? { cwd: event.currentTarget.value } : {}),
                        },
                      });
                    }
                  }}
                />
              </label>
              <Sources
                values={server.transport.env}
                header={false}
                change={(env) => {
                  if (server.transport.type === "stdio")
                    update({ ...server, transport: { ...server.transport, env } });
                }}
              />
            </>
          ) : (
            <>
              <label>
                HTTP endpoint
                <Input
                  value={server.transport.url}
                  onChange={(event) => {
                    if (server.transport.type === "http")
                      update({
                        ...server,
                        transport: { ...server.transport, url: event.currentTarget.value },
                      });
                  }}
                />
              </label>
              <Sources
                values={server.transport.headers}
                header
                change={(headers) => {
                  if (server.transport.type === "http")
                    update({ ...server, transport: { ...server.transport, headers } });
                }}
              />
              <label>
                Authentication
                <Select
                  aria-label="Authentication"
                  value={server.transport.auth.type}
                  onValueChange={(next) => {
                    if (server.transport.type === "http")
                      update({
                        ...server,
                        transport: {
                          ...server.transport,
                          auth:
                            next === "oauth"
                              ? { type: "oauth", scopes: [] }
                              : next === "bearer"
                                ? { type: "bearer", token: { type: "secret", slot: "api-key" } }
                                : { type: "none" },
                        },
                      });
                  }}
                >
                  <SelectItem value="none">None / custom headers</SelectItem>
                  <SelectItem value="bearer">Bearer token</SelectItem>
                  <SelectItem value="oauth">OAuth (DCR supported)</SelectItem>
                </Select>
              </label>
              {server.transport.auth.type === "bearer" && (
                <CredentialSource
                  label="Bearer token"
                  value={server.transport.auth.token}
                  change={(token) => {
                    if (server.transport.type === "http" && token)
                      update({
                        ...server,
                        transport: { ...server.transport, auth: { type: "bearer", token } },
                      });
                  }}
                />
              )}
              {server.transport.auth.type === "oauth" && (
                <>
                  <p className="muted">
                    Leave client ID empty for DCR. A supplied metadata URL is also supported.
                  </p>
                  {(["clientId", "clientMetadataUrl"] as const).map((field) => (
                    <label key={field}>
                      {field === "clientId" ? "Pre-registered client ID" : "Client metadata URL"}
                      <Input
                        value={
                          server.transport.type === "http" && server.transport.auth.type === "oauth"
                            ? (server.transport.auth[field] ?? "")
                            : ""
                        }
                        onChange={(event) => {
                          if (
                            server.transport.type === "http" &&
                            server.transport.auth.type === "oauth"
                          ) {
                            const auth = { ...server.transport.auth };
                            delete auth[field];
                            if (event.currentTarget.value) auth[field] = event.currentTarget.value;
                            update({ ...server, transport: { ...server.transport, auth } });
                          }
                        }}
                      />
                    </label>
                  ))}
                  <label>
                    Scopes (space separated)
                    <Input
                      value={server.transport.auth.scopes.join(" ")}
                      onChange={(event) => {
                        if (
                          server.transport.type === "http" &&
                          server.transport.auth.type === "oauth"
                        )
                          update({
                            ...server,
                            transport: {
                              ...server.transport,
                              auth: {
                                ...server.transport.auth,
                                scopes: event.currentTarget.value.split(/\s+/u).filter(Boolean),
                              },
                            },
                          });
                      }}
                    />
                  </label>
                  <CredentialSource
                    label="OAuth client secret"
                    optional
                    value={server.transport.auth.clientSecret}
                    change={(clientSecret) => {
                      if (
                        server.transport.type !== "http" ||
                        server.transport.auth.type !== "oauth"
                      )
                        return;
                      const auth = { ...server.transport.auth };
                      delete auth.clientSecret;
                      update({
                        ...server,
                        transport: {
                          ...server.transport,
                          auth: { ...auth, ...(clientSecret ? { clientSecret } : {}) },
                        },
                      });
                    }}
                  />
                </>
              )}
            </>
          )}
          <fieldset>
            <legend>Server permission defaults</legend>
            {(["readOnly", "other"] as const).map((category) => (
              <label key={category}>
                {category === "readOnly" ? "Read-only tools" : "Other or unknown tools"}
                <Select
                  value={server.defaults[category] ?? ""}
                  onValueChange={(next) => {
                    const defaults = { ...server.defaults };
                    delete defaults[category];
                    if (next) defaults[category] = toolPermissionSchema.parse(next);
                    update({ ...server, defaults });
                  }}
                >
                  <PermissionOptions inherit />
                </Select>
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Tool overrides</legend>
            {Object.entries(server.tools).map(([name, permission]) => (
              <label key={name}>
                {name}
                <Select
                  value={permission}
                  onValueChange={(permission) => {
                    const tools = { ...server.tools };
                    delete tools[name];
                    if (permission) tools[name] = toolPermissionSchema.parse(permission);
                    update({ ...server, tools });
                  }}
                >
                  <PermissionOptions inherit />
                </Select>
              </label>
            ))}
            <label>
              Exact MCP tool name
              <Input
                value={toolName}
                onChange={(event) => setToolName(event.currentTarget.value)}
                list="mcp-tool-names"
              />
            </label>
            <datalist id="mcp-tool-names">
              {tools
                .filter((tool) => tool.serverId === id)
                .map((tool) => (
                  <option key={tool.name} value={tool.rawName} />
                ))}
            </datalist>
            <Select
              value={toolPermission}
              onValueChange={(next) => setToolPermission(toolPermissionSchema.parse(next))}
            >
              <PermissionOptions />
            </Select>
            <Button
              disabled={!toolName}
              onClick={() => {
                update({ ...server, tools: { ...server.tools, [toolName]: toolPermission } });
                setToolName("");
              }}
            >
              Add tool rule
            </Button>
          </fieldset>
          <Button
            disabled={busy || !id}
            variant="accent"
            onClick={() =>
              run(async () => {
                if (!originalId && Object.hasOwn(config.servers, id))
                  throw new Error("Server ID already exists");
                await save({ ...config, servers: { ...config.servers, [id]: server } });
                setOriginalId(id);
              })
            }
          >
            Save server
          </Button>
          {originalId && (
            <>
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const next = { ...config.servers };
                    delete next[originalId];
                    await save({ ...config, servers: next });
                    setServer(undefined);
                    setOriginalId(undefined);
                  })
                }
              >
                Remove server
              </Button>
              <p>
                {status?.status} · {status?.toolCount ?? 0} active tools
                {status?.authenticated ? " · credentials available" : ""}
                {status?.signingIn ? " · signing in" : ""}
              </p>
              {status?.detail && <p>{status.detail}</p>}
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const result = await client.peer.request(mcpTest, { serverId: id });
                    setNotice(
                      `${result.status} · ${result.toolCount} tools${result.detail ? ` · ${result.detail}` : ""}`,
                    );
                  })
                }
              >
                Test saved connection
              </Button>
              <fieldset>
                <legend>Stored credentials</legend>
                <label>
                  Slot
                  <Input value={slot} onChange={(event) => setSlot(event.currentTarget.value)} />
                </label>
                <label>
                  Credential
                  <Input
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(event) => setSecret(event.currentTarget.value)}
                  />
                </label>
                <Button
                  disabled={busy || !slot || !secret}
                  onClick={() => {
                    const value = secret;
                    setSecret("");
                    run(async () => {
                      await client.peer.request(mcpCredentialSet, { serverId: id, slot, value });
                      await refresh();
                      setNotice("Credential stored. Restart to activate changes.");
                    });
                  }}
                >
                  Replace credential
                </Button>
                <Button
                  disabled={busy || !slot}
                  onClick={() =>
                    run(async () => {
                      await client.peer.request(mcpCredentialDelete, { serverId: id, slot });
                      await refresh();
                      setNotice("Stored credential removed. Restart to activate changes.");
                    })
                  }
                >
                  Delete credential
                </Button>
                {status?.credentials.map((credential) => (
                  <p key={credential.slot}>
                    {credential.slot}: {credential.present ? "Stored" : "Missing"}
                  </p>
                ))}
              </fieldset>
              {server.transport.type === "http" && server.transport.auth.type === "oauth" && (
                <>
                  <Button
                    disabled={busy || !!attempt || !!status?.signingIn}
                    onClick={() =>
                      run(async () => {
                        const mounted = owner.current;
                        const result = await client.peer.request(mcpAuthStart, { serverId: id });
                        if (!mounted || owner.current !== mounted) {
                          await client.peer.request(mcpAuthCancel, { attemptId: result.attemptId });
                          return;
                        }
                        mounted.attemptId = result.attemptId;
                        setAttempt({ ...result, serverId: id });
                        await openUrl(result.url);
                      })
                    }
                  >
                    Sign in with OAuth
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await client.peer.request(mcpAuthLogout, { serverId: id });
                        await refresh();
                        setNotice("Signed out. Restart to activate changes.");
                      })
                    }
                  >
                    Sign out
                  </Button>
                </>
              )}
            </>
          )}
        </>
      )}
      {attempt && (
        <fieldset>
          <legend>OAuth sign-in</legend>
          <p>
            <a
              href={attempt.url}
              onClick={(event) => {
                event.preventDefault();
                run(() => openUrl(attempt.url));
              }}
            >
              Open sign-in page
            </a>
          </p>
          <p className="muted">
            For a remote host, paste the full redirected URL from your browser.
          </p>
          <label>
            Redirected URL
            <Input value={callback} onChange={(event) => setCallback(event.currentTarget.value)} />
          </label>
          <Button
            disabled={busy || !callback}
            onClick={() => {
              const callbackUrl = callback;
              setCallback("");
              run(async () => {
                await client.peer.request(mcpAuthComplete, {
                  attemptId: attempt.attemptId,
                  callbackUrl,
                });
                if (owner.current) delete owner.current.attemptId;
                setAttempt(undefined);
                await refresh();
                setNotice("Signed in. Restart to activate tools.");
              });
            }}
          >
            Complete sign-in
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await client.peer.request(mcpAuthCancel, { attemptId: attempt.attemptId });
                if (owner.current) delete owner.current.attemptId;
                setAttempt(undefined);
                await refresh();
              })
            }
          >
            Cancel sign-in
          </Button>
        </fieldset>
      )}
      <Button
        disabled={busy}
        onClick={() =>
          run(async () => {
            await refresh();
            setNotice("Status refreshed");
          })
        }
      >
        Refresh status
      </Button>
      {(data!.restartRequired || notice?.includes("Restart") || notice?.includes("restart")) && (
        <Button onClick={() => run(restart)}>Restart server</Button>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
