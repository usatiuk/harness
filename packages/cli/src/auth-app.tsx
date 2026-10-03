import { useEffect, useState, type ReactElement } from "react";
import { Box, Text, render, useApp } from "ink";
import { Alert, PasswordInput, Select, Spinner } from "@inkjs/ui";
import type { ModelConfig } from "@harness/protocol";
import {
  AUTH_STORE_KINDS,
  defaultHome,
  readGlobalSettings,
  setAuthStore,
  updateGlobalModel,
  type AuthStoreKind,
} from "@harness/config";
import { defaultCredentialsPath, defaultDpapiCredentialsPath } from "@harness/secrets";
import type { ApiKeyMethod, OAuthMethod } from "@harness/auth";
import { authRegistry, authEntries, prepareProviderEntries, type AuthEntry } from "./auth.ts";
import { credentialStoreForLogin, credentialStoreForRead } from "./credential-store.ts";

const modelLabel = (m: ModelConfig): string => `${m.provider}/${m.model}`;
const modelNotice = (entry: AuthEntry): string =>
  entry.defaultModel
    ? ` Default model → ${modelLabel(entry.defaultModel)}.`
    : " Restart Harness to use this connection.";

interface LoginAppProps {
  registry: Map<string, AuthEntry>;
  provider?: string | undefined;
  onResolve: (message: string) => void;
  onReject: (error: Error) => void;
  /** Persists backend + model after sign-in; injectable for test isolation. */
  persist: (entry: AuthEntry) => Promise<void>;
}

/** Provider picker → key paste or browser flow, resolving with a success line to print. */
export function LoginApp({
  registry,
  provider,
  onResolve,
  onReject,
  persist,
}: LoginAppProps): ReactElement {
  const [chosen, setChosen] = useState<AuthEntry | undefined>(
    provider ? registry.get(provider) : undefined,
  );

  if (!chosen) {
    const options = [...registry.values()].map((e) => ({
      label: e.method.kind === "oauth" ? `${e.method.label} · browser sign-in` : e.method.label,
      value: e.method.id,
    }));
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Sign in to a provider</Text>
        <Select options={options} onChange={(v) => setChosen(registry.get(v))} />
      </Box>
    );
  }

  return chosen.method.kind === "api-key" ? (
    <ApiKeyLogin
      entry={chosen}
      method={chosen.method}
      persist={persist}
      onResolve={onResolve}
      onReject={onReject}
    />
  ) : (
    <OAuthLogin
      entry={chosen}
      method={chosen.method}
      persist={persist}
      onResolve={onResolve}
      onReject={onReject}
    />
  );
}

interface BranchProps<M> {
  entry: AuthEntry;
  method: M;
  persist: (entry: AuthEntry) => Promise<void>;
  onResolve: (message: string) => void;
  onReject: (error: Error) => void;
}

function ApiKeyLogin({
  entry,
  method,
  persist,
  onResolve,
}: BranchProps<ApiKeyMethod>): ReactElement {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!method.canStore) onResolve(`Set $${method.envVar} to configure ${method.label}.`);
  }, [method, onResolve]);

  if (!method.canStore) return <Text>{`Set ${method.envVar} to configure ${method.label}.`}</Text>;

  const submit = (value: string): void => {
    method
      .submit(value)
      .then(() => persist(entry))
      .then(() => onResolve(`Signed in to ${method.label}.${modelNotice(entry)}`))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <Box flexDirection="column">
      <Text>{`Paste your ${method.label} key${method.envVar ? ` (overridden by ${method.envVar} when set)` : ""}:`}</Text>
      <PasswordInput placeholder="key is hidden as you type" onSubmit={submit} />
      {error ? <Alert variant="error">{error}</Alert> : null}
    </Box>
  );
}

function OAuthLogin({
  entry,
  method,
  persist,
  onResolve,
  onReject,
}: BranchProps<OAuthMethod>): ReactElement {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    method
      .login({ onUrl: setUrl })
      .then(() => persist(entry))
      .then(() => onResolve(`Signed in.${modelNotice(entry)}`))
      .catch((e: unknown) => onReject(e instanceof Error ? e : new Error(String(e))));
    // The method instance is stable for the lifetime of this flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box flexDirection="column">
      <Spinner label="Opening your browser to sign in…" />
      {url ? (
        <Alert variant="info" title="If your browser didn't open, visit">
          {url}
        </Alert>
      ) : null}
    </Box>
  );
}

type CompletionBuilder = (
  onResolve: (message: string) => void,
  onReject: (error: Error) => void,
) => ReactElement;

function CompletionRoot({ build }: { build: CompletionBuilder }): ReactElement {
  const { exit } = useApp();
  return build(exit, exit);
}

/** Renders an Ink element until it exits with the message it produced. */
async function renderToCompletion(build: CompletionBuilder): Promise<string> {
  const result = await render(<CompletionRoot build={build} />).waitUntilExit();
  if (typeof result !== "string") throw new Error("login UI exited without a result");
  return result;
}

const unknownProvider = (registry: Map<string, AuthEntry>, id: string): Error =>
  new Error(`unknown provider: ${id} (known: ${[...registry.keys()].join(", ")})`);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export interface LoginCliOptions {
  provider?: string | undefined;
  /** Force a credential backend. Windows supports DPAPI; keyring and file are Unix-only. */
  store?: string | undefined;
}

/** Validates a raw `--store` value into a backend kind. */
function parseStore(value: string | undefined): AuthStoreKind | undefined {
  if (value === undefined) return undefined;
  const kind = AUTH_STORE_KINDS.find((k) => k === value);
  if (!kind) {
    throw new Error(`--store must be one of: ${AUTH_STORE_KINDS.join(", ")} (got "${value}")`);
  }
  return kind;
}

/** `harness auth login`: interactive picker, or a non-interactive stdin path for CI. */
export async function runLogin(opts: LoginCliOptions = {}): Promise<void> {
  const home = defaultHome();
  const prepare = prepareProviderEntries(await readGlobalSettings(home));
  const { store, kind } = await credentialStoreForLogin(home, parseStore(opts.store));
  const registry = authEntries(prepare(store));
  if (opts.provider && !registry.has(opts.provider)) throw unknownProvider(registry, opts.provider);

  // Persist the backend choice and default model together, only after a successful sign-in.
  const persist = async (entry: AuthEntry): Promise<void> => {
    await setAuthStore(home, kind);
    if (entry.defaultModel) await updateGlobalModel(home, entry.defaultModel);
  };
  const storageNote =
    kind === "file"
      ? ` Stored at ${defaultCredentialsPath()} (mode 0600 — no OS keyring here).`
      : kind === "dpapi"
        ? ` Stored at ${defaultDpapiCredentialsPath()} (protected by Windows DPAPI).`
        : "";

  // Read the key from a pipe only when stdin isn't a TTY (CI). A live TTY always gets the
  // interactive flow — even if stdout is redirected — so we never block waiting on stdin EOF.
  if (!process.stdin.isTTY) {
    await loginNonInteractive(registry, opts, persist, storageNote);
    return;
  }
  const message = await renderToCompletion((onResolve, onReject) => (
    <LoginApp
      registry={registry}
      provider={opts.provider}
      persist={persist}
      onResolve={onResolve}
      onReject={onReject}
    />
  ));
  console.log(message + storageNote);
}

/** Non-TTY login: requires a provider and reads an API key from stdin. */
async function loginNonInteractive(
  registry: Map<string, AuthEntry>,
  opts: LoginCliOptions,
  persist: (entry: AuthEntry) => Promise<void>,
  storageNote: string,
): Promise<void> {
  if (!opts.provider) throw new Error("non-interactive login requires --provider <id>");
  const entry = registry.get(opts.provider);
  if (!entry) throw unknownProvider(registry, opts.provider);
  if (entry.method.kind !== "api-key") {
    throw new Error(
      `${opts.provider} signs in via the browser; run \`harness auth login\` in a terminal`,
    );
  }
  if (!entry.method.canStore)
    throw new Error(`Set $${entry.method.envVar} to configure ${entry.method.label}.`);
  await entry.method.submit(await readStdin());
  await persist(entry);
  console.log(`Signed in to ${entry.method.label}.${modelNotice(entry)}${storageNote}`);
}

/** `harness auth status`: one provider with `--provider`, otherwise all of them. */
export async function runStatus(provider?: string): Promise<void> {
  const { store } = await credentialStoreForRead(defaultHome());
  const registry = authRegistry(store, await readGlobalSettings(defaultHome()));
  const entries = provider ? [requireEntry(registry, provider)] : [...registry.values()];
  for (const entry of entries) {
    const s = await entry.method.status();
    const label = entry.method.label.padEnd(22);
    if (!s.authenticated) {
      console.log(`✗ ${label} not signed in`);
      continue;
    }
    const parts: string[] = [];
    if (s.detail) parts.push(s.detail);
    if (s.expiresAt) parts.push(`token expires ${new Date(s.expiresAt).toISOString()}`);
    console.log(`✓ ${label} ${parts.join(", ")}`.trimEnd());
  }
}

/** `harness auth logout --provider <id>`: clears one provider's stored credentials. */
export async function runLogout(provider?: string): Promise<void> {
  const { store } = await credentialStoreForRead(defaultHome());
  const registry = authRegistry(store, await readGlobalSettings(defaultHome()));
  if (!provider) {
    console.log(`specify --provider <id> (one of: ${[...registry.keys()].join(", ")})`);
    return;
  }
  const entry = requireEntry(registry, provider);
  const removed = await entry.method.logout();
  console.log(
    removed ? `Signed out of ${entry.method.label}.` : `${entry.method.label}: was not signed in`,
  );
}

function requireEntry(registry: Map<string, AuthEntry>, id: string): AuthEntry {
  const entry = registry.get(id);
  if (!entry) throw unknownProvider(registry, id);
  return entry;
}
