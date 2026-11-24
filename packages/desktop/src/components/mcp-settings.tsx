import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  Button,
  Checkbox,
  Dialog,
  Disclosure,
  Input,
  Select,
  SelectItem,
  Textarea,
} from "../ui.tsx";

import { McpTimeoutFields } from "./mcp-timeouts.tsx";
import { SettingsGroup } from "./settings-layout.tsx";

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
            size="sm"
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
        size="sm"
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
  active = true,
  openUrl,
  restart,
}: {
  client: HarnessClient;
  active?: boolean;
  openUrl: (url: string) => Promise<void>;
  restart: () => Promise<void>;
}) {
  const [data, setData] = useState<McpSettingsData>();
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [id, setId] = useState("");
  const [originalId, setOriginalId] = useState<string>();
  const [server, setServer] = useState<McpServerConfig>();
  const addButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [slot, setSlot] = useState("api-key"),
    [secret, setSecret] = useState("");
  const [bearerToken, setBearerToken] = useState("");
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
  const refresh = useCallback(async () => {
    const mounted = owner.current;
    const ownedId = mounted?.attemptId;
    const [settings, catalog] = await Promise.all([
      client.peer.request(mcpSettingsGet, {}),
      client.peer.request(mcpToolsList, {}),
    ]);
    if (!mounted || owner.current !== mounted || mounted.attemptId !== ownedId) return;
    setData(settings);
    setTools(catalog);
    if (attempt && ownedId === attempt.attemptId) {
      const status = settings.active.find((entry) => entry.id === attempt.serverId);
      if (!status?.signingIn) {
        // Changed/removed targets can leave a listener; cancel by owned ID (a no-op if completed).
        await client.peer.request(mcpAuthCancel, { attemptId: ownedId });
        if (owner.current !== mounted || mounted.attemptId !== ownedId) return;
        delete mounted.attemptId;
        setAttempt(undefined);
        setCallback("");
      }
    }
  }, [client, attempt]);
  useEffect(() => {
    if (!attempt) return;
    const onReturn = () => {
      void refresh().catch(() => setNotice("Unable to read MCP settings"));
    };
    window.addEventListener("focus", onReturn);
    return () => window.removeEventListener("focus", onReturn);
  }, [attempt, refresh]);
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
  const clearEditor = () => {
    setId(originalId ?? "");
    setOriginalId(undefined);
    setServer(undefined);
    setSecret("");
    setBearerToken("");
    setSlot("api-key");
    setToolName("");
    setToolPermission("ask");
  };
  if (!config || !data) return <p>{notice ?? "Reading MCP settings…"}</p>;
  const status = data.active.find((entry) => entry.id === id);
  const savedTransport = originalId ? config.servers[originalId]?.transport : undefined;
  const lifecycle = (
    <>
      {attempt && (
        <fieldset>
          <legend>OAuth sign-in · {attempt.serverId}</legend>
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
            size="sm"
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
            size="sm"
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
      {(!server || originalId) &&
        (data.restartRequired || notice?.toLowerCase().includes("restart")) && (
          <Button size="sm" disabled={busy} onClick={() => run(restart)}>
            Restart server
          </Button>
        )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
  return (
    <div className="settings-stack mcp-settings">
      <SettingsGroup
        title="Configured servers"
        action={
          <Button
            ref={addButton}
            size="sm"
            variant="accent"
            disabled={busy}
            onClick={() => {
              setId("");
              setNotice(undefined);
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
        }
      >
        {Object.keys(config.servers).length ? (
          <ul className="mcp-server-list" aria-label="Configured MCP servers">
            {Object.entries(config.servers).map(([key, entry]) => {
              const active = data.active.find((status) => status.id === key);
              return (
                <li key={key}>
                  <div>
                    <strong>{key}</strong>
                    <p className="muted">
                      {entry.transport.type === "http" ? "Hosted HTTP" : "Local stdio"} ·{" "}
                      {active?.status ?? "Not loaded"} · {active?.toolCount ?? 0} tools
                    </p>
                    {active?.detail && <p>{active.detail}</p>}
                  </div>
                  <Button
                    ref={id === key ? editButton : undefined}
                    size="sm"
                    aria-label={`Edit ${key}`}
                    disabled={busy}
                    onClick={() => {
                      setId(key);
                      setOriginalId(key);
                      setServer(structuredClone(entry));
                      setNotice(undefined);
                    }}
                  >
                    Edit
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">No servers configured.</p>
        )}
      </SettingsGroup>
      <SettingsGroup title="Default tool permissions">
        {(["readOnly", "other"] as const).map((category) => (
          <label key={category}>
            {category === "readOnly" ? "Read-only tools" : "Other or unknown tools"}
            <Select
              disabled={busy}
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
      </SettingsGroup>
      <McpTimeoutFields
        defaults={config.timeouts}
        disabled={busy}
        onSave={(timeouts) =>
          run(() => save({ ...config, timeouts: { ...config.timeouts, ...timeouts } }))
        }
      />
      {!server && lifecycle}
      <Dialog.Root
        open={active && !!server}
        onOpenChange={(open) => {
          if (!open && !busy) clearEditor();
        }}
      >
        {server && (
          <Dialog.Content
            className="mcp-editor-dialog settings-stack mcp-settings"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              (editButton.current ?? addButton.current)?.focus();
            }}
          >
            <header className="section-heading">
              <Dialog.Title>{originalId ? `Edit ${originalId}` : "Add MCP server"}</Dialog.Title>
              <Dialog.Description>
                Configure this host’s tool connection. Save the server to keep your changes.
              </Dialog.Description>
            </header>
            <SettingsGroup title="Server identity">
              <label>
                Server ID
                <Input
                  autoFocus
                  value={id}
                  readOnly={!!originalId}
                  onChange={(event) => setId(event.currentTarget.value)}
                />
              </label>
              <Checkbox
                label="Enabled"
                checked={server.enabled}
                onChange={(event) => update({ ...server, enabled: event.currentTarget.checked })}
              />
            </SettingsGroup>
            <SettingsGroup title="Connection">
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
                            transport: {
                              ...server.transport,
                              executable: event.currentTarget.value,
                            },
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
                  <Disclosure title="Advanced local settings">
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
                                ...(event.currentTarget.value
                                  ? { cwd: event.currentTarget.value }
                                  : {}),
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
                  </Disclosure>
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
                  <Disclosure title="Custom headers">
                    <Sources
                      values={server.transport.headers}
                      header
                      change={(headers) => {
                        if (server.transport.type === "http")
                          update({ ...server, transport: { ...server.transport, headers } });
                      }}
                    />
                  </Disclosure>
                  <label>
                    Authentication
                    <Select
                      aria-label="Authentication"
                      value={server.transport.auth.type}
                      onValueChange={(next) => {
                        setSecret("");
                        setBearerToken("");
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
                      <SelectItem value="oauth">Browser sign-in (OAuth / DCR)</SelectItem>
                    </Select>
                  </label>
                  {server.transport.auth.type === "bearer" && (
                    <>
                      {server.transport.auth.token.type === "secret" ? (
                        <label>
                          Bearer token
                          <Input
                            type="password"
                            autoComplete="off"
                            value={bearerToken}
                            placeholder={
                              status?.credentials.some(
                                (credential) =>
                                  server.transport.type === "http" &&
                                  server.transport.auth.type === "bearer" &&
                                  server.transport.auth.token.type === "secret" &&
                                  credential.slot === server.transport.auth.token.slot &&
                                  credential.present,
                              )
                                ? "Stored · leave blank to keep"
                                : "Enter token"
                            }
                            onChange={(event) => setBearerToken(event.currentTarget.value)}
                          />
                        </label>
                      ) : (
                        <p className="muted">Token comes from host environment.</p>
                      )}
                      <Disclosure title="Advanced token source">
                        <CredentialSource
                          label="Bearer token source"
                          value={server.transport.auth.token}
                          change={(token) => {
                            if (server.transport.type === "http" && token) {
                              setSecret("");
                              setBearerToken("");
                              update({
                                ...server,
                                transport: { ...server.transport, auth: { type: "bearer", token } },
                              });
                            }
                          }}
                        />
                      </Disclosure>
                    </>
                  )}
                  {server.transport.auth.type === "oauth" && (
                    <Disclosure title="Advanced OAuth settings">
                      <p className="muted">
                        Leave client ID empty for DCR. A supplied metadata URL is also supported.
                      </p>
                      {(["clientId", "clientMetadataUrl"] as const).map((field) => (
                        <label key={field}>
                          {field === "clientId"
                            ? "Pre-registered client ID"
                            : "Client metadata URL"}
                          <Input
                            value={
                              server.transport.type === "http" &&
                              server.transport.auth.type === "oauth"
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
                                if (event.currentTarget.value)
                                  auth[field] = event.currentTarget.value;
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
                    </Disclosure>
                  )}
                </>
              )}
            </SettingsGroup>
            <McpTimeoutFields
              defaults={config.timeouts}
              overrides={server.timeouts ?? {}}
              stdio={server.transport.type === "stdio"}
              disabled={busy}
              onSave={(timeouts) => update({ ...server, timeouts })}
            />
            <Disclosure title="Tool permissions">
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
                  aria-label="Tool rule permission"
                  value={toolPermission}
                  onValueChange={(next) => setToolPermission(toolPermissionSchema.parse(next))}
                >
                  <PermissionOptions />
                </Select>
                <Button
                  size="sm"
                  disabled={!toolName}
                  onClick={() => {
                    update({ ...server, tools: { ...server.tools, [toolName]: toolPermission } });
                    setToolName("");
                  }}
                >
                  Add tool rule
                </Button>
              </fieldset>
            </Disclosure>
            <div className="button-row">
              <Button
                size="sm"
                disabled={busy || !id}
                variant="accent"
                onClick={() =>
                  run(async () => {
                    if (!originalId && Object.hasOwn(config.servers, id))
                      throw new Error("Server ID already exists");
                    await save({ ...config, servers: { ...config.servers, [id]: server } });
                    setOriginalId(id);
                    if (
                      bearerToken &&
                      server.transport.type === "http" &&
                      server.transport.auth.type === "bearer" &&
                      server.transport.auth.token.type === "secret"
                    ) {
                      const value = bearerToken;
                      setBearerToken("");
                      try {
                        await client.peer.request(mcpCredentialSet, {
                          serverId: id,
                          slot: server.transport.auth.token.slot,
                          value,
                        });
                      } catch (cause) {
                        throw new Error(
                          `Server saved, but token was not stored: ${cause instanceof Error ? cause.message : "Credential write failed"}`,
                          { cause },
                        );
                      }
                      await refresh();
                    }
                  })
                }
              >
                Save server
              </Button>
              {originalId && (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const next = { ...config.servers };
                      delete next[originalId];
                      await save({ ...config, servers: next });
                      clearEditor();
                    })
                  }
                >
                  Remove server
                </Button>
              )}
            </div>
            {originalId && (
              <SettingsGroup title="Saved connection">
                <p>
                  Active: {status?.status ?? "Not loaded"} · {status?.toolCount ?? 0} tools
                  {status?.authenticated ? " · credentials available" : ""}
                  {status?.signingIn ? " · signing in" : ""}
                </p>
                {status?.detail && <p>{status.detail}</p>}
                {status?.authenticated && status.status !== "ready" && (
                  <p className="muted">
                    Signed in; test the saved connection, then restart to activate tools.
                  </p>
                )}
                <Button
                  size="sm"
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
                {((savedTransport?.type === "http" &&
                  savedTransport.auth.type === "oauth" &&
                  savedTransport.auth.clientSecret) ||
                  (status?.credentials.length ?? 0) > 0) && (
                  <Disclosure title="Manage stored credentials">
                    <fieldset>
                      <legend>Stored credentials</legend>
                      <label>
                        Slot
                        <Input
                          value={slot}
                          onChange={(event) => setSlot(event.currentTarget.value)}
                        />
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
                        size="sm"
                        disabled={busy || !slot || !secret}
                        onClick={() => {
                          const value = secret;
                          setSecret("");
                          run(async () => {
                            await client.peer.request(mcpCredentialSet, {
                              serverId: id,
                              slot,
                              value,
                            });
                            await refresh();
                            setNotice("Credential stored. Restart to activate changes.");
                          });
                        }}
                      >
                        Replace credential
                      </Button>
                      <Button
                        size="sm"
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
                  </Disclosure>
                )}
                {savedTransport?.type === "http" && savedTransport.auth.type === "oauth" && (
                  <div className="button-row">
                    <Button
                      size="sm"
                      disabled={busy || !!attempt || !!status?.signingIn}
                      onClick={() =>
                        run(async () => {
                          const mounted = owner.current;
                          const result = await client.peer.request(mcpAuthStart, { serverId: id });
                          if (!mounted || owner.current !== mounted) {
                            await client.peer.request(mcpAuthCancel, {
                              attemptId: result.attemptId,
                            });
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
                      size="sm"
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
                  </div>
                )}
              </SettingsGroup>
            )}
            {lifecycle}
          </Dialog.Content>
        )}
      </Dialog.Root>
    </div>
  );
}
