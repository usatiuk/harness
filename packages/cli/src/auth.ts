import { defaultHome, updateGlobalModel } from "@harness/config";
import { KeyringSecretStore } from "@harness/secrets";
import { CodexAuth } from "@harness/openai-codex";

const CODEX_DEFAULT_MODEL = "gpt-5.1-codex";

/**
 * The auth-provider dispatch seam. One entry today (`openai-codex`); a second provider is a
 * new entry here, not a refactor.
 */
const PROVIDERS: Record<string, () => CodexAuth> = {
  "openai-codex": () => new CodexAuth({ store: new KeyringSecretStore() }),
};

function authFor(provider: string): CodexAuth {
  const make = PROVIDERS[provider];
  if (!make)
    throw new Error(
      `unknown auth provider: ${provider} (known: ${Object.keys(PROVIDERS).join(", ")})`,
    );
  return make();
}

/** Runs the browser login flow and makes the provider the global default model. */
export async function runLogin(provider: string): Promise<void> {
  const auth = authFor(provider);
  console.log("Opening your browser to sign in to Codex…");
  const session = await auth.loginWithBrowser({
    onUrl: (url) => console.log(`\nIf the browser does not open, visit:\n${url}\n`),
  });
  await updateGlobalModel(defaultHome(), { provider, model: CODEX_DEFAULT_MODEL });
  const who = session.email ? ` as ${session.email}` : "";
  console.log(`Signed in${who}. Default model set to ${provider}/${CODEX_DEFAULT_MODEL}.`);
}

export async function runStatus(provider: string): Promise<void> {
  const status = await authFor(provider).status();
  if (!status.authenticated) {
    console.log(`${provider}: not signed in`);
    return;
  }
  const expires = status.expiresAt ? new Date(status.expiresAt).toISOString() : "unknown";
  const who = status.email ? ` as ${status.email}` : "";
  console.log(
    `${provider}: signed in${who} (account ${status.accountId}, token expires ${expires})`,
  );
}

export async function runLogout(provider: string): Promise<void> {
  const removed = await authFor(provider).logout();
  console.log(removed ? `${provider}: signed out` : `${provider}: was not signed in`);
}
