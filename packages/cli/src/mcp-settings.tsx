import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { PasswordInput, Select, Spinner, TextInput } from "@inkjs/ui";
import { formatError, jsonValueSchema } from "@harness/protocol";
import {
  mcpSettingsGet,
  mcpSettingsSet,
  mcpConfigSchema,
  mcpTest,
  mcpCredentialSet,
  mcpCredentialDelete,
  mcpAuthStart,
  mcpAuthComplete,
  mcpAuthCancel,
  mcpAuthLogout,
  type McpSettingsData,
} from "@harness/mcp/client";
import type { TuiHostView } from "./hosts.ts";

export function McpSettings({
  view,
  onError,
}: {
  view: TuiHostView;
  onError: (error: string) => void;
}) {
  const peer = view.harness!.client.peer;
  const [data, setData] = useState<McpSettingsData>();
  const [screen, setScreen] = useState("menu");
  const [serverId, setServerId] = useState("");
  const [slot, setSlot] = useState("");
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<{ attemptId: string; url: string; redirectUrl: string }>();
  const activeAttempt = useRef<{ attemptId: string; serverId: string } | undefined>(undefined);
  const pending = useRef<AbortController | undefined>(undefined);
  const refresh = async () => {
    const next = await peer.request(mcpSettingsGet, {});
    setData(next);
    const owned = activeAttempt.current;
    if (owned && !next.active.some((server) => server.id === owned.serverId && server.signingIn)) {
      await peer.request(mcpAuthCancel, { attemptId: owned.attemptId });
      setAttempt(undefined);
      activeAttempt.current = undefined;
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void peer
      .request(mcpSettingsGet, {}, { signal: controller.signal })
      .then(setData)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) onError(formatError(cause));
      });
    return () => {
      controller.abort();
      pending.current?.abort();
      if (activeAttempt.current)
        void peer
          .request(mcpAuthCancel, { attemptId: activeAttempt.current.attemptId })
          .catch(() => {});
    };
  }, [peer, onError]);
  const run = (work: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setNotice(undefined);
    void work(controller.signal)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) onError(formatError(cause));
      })
      .finally(() => {
        pending.current = undefined;
        setBusy(false);
      });
  };
  if (!data) return <Spinner label="Reading MCP settings" />;
  const config = mcpConfigSchema.parse(data.config);
  const status = data.active.find((server) => server.id === serverId);
  const choose = (action: string) => {
    if (action === "refresh")
      run(async () => {
        await refresh();
        setNotice("Status refreshed");
      });
    else if (action === "test")
      run(async (signal) => {
        const result = await peer.request(mcpTest, { serverId }, { signal });
        setNotice(
          `${result.status}: ${result.toolCount} tools${result.detail ? ` · ${result.detail}` : ""}`,
        );
      });
    else if (action === "login")
      run(async (signal) => {
        const next = await peer.request(mcpAuthStart, { serverId }, { signal });
        activeAttempt.current = { attemptId: next.attemptId, serverId };
        setAttempt(next);
        setScreen("callback");
      });
    else if (action === "logout")
      run(async () => {
        await peer.request(mcpAuthLogout, { serverId });
        await refresh();
        setNotice("Signed out. Restart this host.");
      });
    else if (action === "cancel")
      run(async () => {
        if (activeAttempt.current)
          await peer.request(mcpAuthCancel, { attemptId: activeAttempt.current.attemptId });
        activeAttempt.current = undefined;
        setAttempt(undefined);
        setScreen("server");
        await refresh();
      });
    else setScreen(action);
  };
  const oauth = config.servers[serverId]?.transport;
  return (
    <Box flexDirection="column">
      <Text bold>{`MCP on ${view.host.label}`}</Text>
      <Text
        dimColor
      >{`Host-owned settings and credentials. Backend: ${data.credentialBackend ?? "selected on first write"}. Restart the host to activate changes.`}</Text>
      {notice && <Text>{notice}</Text>}
      {busy ? (
        <Spinner label="Working (Esc leaves and cancels)" />
      ) : screen === "config" ? (
        <>
          <Text>
            Edit MCP JSON: stdio executable/args/cwd/env; HTTP url/headers/auth; defaults and exact
            tool rules.
          </Text>
          <Text dimColor>
            Sources: {`{"type":"env","name":"VARIABLE"}`} or {`{"type":"secret","slot":"api-key"}`}.
            Literal values are plaintext. Permissions: allow, ask, ask-human, deny.
          </Text>
          <TextInput
            defaultValue={JSON.stringify(config)}
            onSubmit={(text) => {
              try {
                const next = mcpConfigSchema.parse(JSON.parse(text));
                run(async () => {
                  await peer.request(mcpSettingsSet, { config: jsonValueSchema.parse(next) });
                  await refresh();
                  setScreen("menu");
                  setNotice("Saved. Restart this host.");
                });
              } catch (cause) {
                onError(formatError(cause));
              }
            }}
          />
        </>
      ) : screen === "select" ? (
        <Select
          options={[
            ...Object.keys(config.servers).map((id) => ({ label: id, value: id })),
            { label: "Back", value: "" },
          ]}
          onChange={(id) => {
            setServerId(id);
            setScreen(id ? "server" : "menu");
          }}
        />
      ) : screen === "slot" || screen === "delete-slot" ? (
        <>
          <Text>
            {screen === "slot" ? "Credential slot to replace:" : "Credential slot to delete:"}
          </Text>
          <TextInput
            onSubmit={(value) => {
              if (!value.trim()) return;
              setSlot(value.trim());
              if (screen === "slot") setScreen("password");
              else
                run(async () => {
                  await peer.request(mcpCredentialDelete, { serverId, slot: value.trim() });
                  await refresh();
                  setScreen("server");
                  setNotice("Credential deleted. Restart this host.");
                });
            }}
          />
        </>
      ) : screen === "password" ? (
        <>
          <Text>{`Credential for ${serverId}/${slot}:`}</Text>
          <PasswordInput
            onSubmit={(value) => {
              setScreen("server");
              run(async () => {
                await peer.request(mcpCredentialSet, { serverId, slot, value });
                await refresh();
                setNotice("Credential stored. Restart this host.");
              });
            }}
          />
        </>
      ) : screen === "callback" && attempt ? (
        <>
          <Text>{`Open ${attempt.url}`}</Text>
          <Text>
            Paste the full redirected URL, or submit an empty line to refresh after a local
            callback:
          </Text>
          <TextInput
            onSubmit={(callbackUrl) =>
              run(async () => {
                if (callbackUrl) {
                  await peer.request(mcpAuthComplete, {
                    attemptId: attempt.attemptId,
                    callbackUrl,
                  });
                  activeAttempt.current = undefined;
                  setAttempt(undefined);
                }
                await refresh();
                setScreen("server");
                setNotice("Status refreshed. Restart after successful sign-in.");
              })
            }
          />
        </>
      ) : screen === "server" ? (
        <>
          <Text>{`${serverId}: ${status?.status ?? "unavailable"} · ${status?.toolCount ?? 0} active tools${status?.authenticated ? " · credentials available" : ""}${status?.signingIn ? " · signing in" : ""}`}</Text>
          {status?.detail && <Text>{status.detail}</Text>}
          {status?.credentials.map((credential) => (
            <Text
              key={credential.slot}
            >{`${credential.slot}: ${credential.present ? "Stored" : "Missing"}`}</Text>
          ))}
          <Select
            options={[
              { label: "Test saved connection", value: "test" },
              { label: "Replace stored credential", value: "slot" },
              { label: "Delete stored credential", value: "delete-slot" },
              ...(oauth?.type === "http" && oauth.auth.type === "oauth"
                ? [
                    ...(!attempt && !status?.signingIn
                      ? [{ label: "OAuth sign-in", value: "login" }]
                      : []),
                    { label: "OAuth sign-out", value: "logout" },
                  ]
                : []),
              ...(attempt
                ? [
                    { label: "Continue sign-in", value: "callback" },
                    { label: "Cancel sign-in", value: "cancel" },
                  ]
                : []),
              { label: "Refresh status", value: "refresh" },
              { label: "Back", value: "menu" },
            ]}
            onChange={choose}
          />
        </>
      ) : (
        <Select
          options={[
            { label: "Edit MCP configuration", value: "config" },
            { label: "Server connection / credentials / OAuth", value: "select" },
            { label: "Refresh status", value: "refresh" },
          ]}
          onChange={choose}
        />
      )}
    </Box>
  );
}
