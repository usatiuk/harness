import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Substitute the provider HTTP edge in a real Node server, preserving all auth/store/RPC code. */
export async function deviceAuthFixture(directory: string) {
  const allow = join(directory, "authorize-device");
  const cancelled = join(directory, "device-cancelled");
  const polling = join(directory, "device-polling");
  const preload = join(directory, "device-auth-network.mjs");
  const jwt = (payload: unknown) =>
    `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
  const refreshToken = "device-fixture-refresh-token";
  const token = {
    access_token: jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "fixture-device-account" },
    }),
    id_token: jwt({ email: "device-fixture@example.com" }),
    refresh_token: refreshToken,
    expires_in: 3600,
  };
  await writeFile(
    preload,
    `
import { existsSync, writeFileSync } from 'node:fs';
const fetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith('https://auth.openai.com/')) return fetch(input, init);
  if (url.endsWith('/deviceauth/usercode')) return Response.json({device_auth_id:'fixture-device',user_code:'FIXTURE-CODE',interval:'1'});
  if (url.endsWith('/deviceauth/token')) {
    if (existsSync(${JSON.stringify(allow)})) return Response.json({authorization_code:'fixture-grant',code_verifier:'fixture-verifier'});
    return new Promise((_resolve, reject) => {
      const cancel = () => {writeFileSync(${JSON.stringify(cancelled)}, 'cancelled'); reject(init.signal.reason);};
      init.signal.addEventListener('abort', cancel, {once:true});
      writeFileSync(${JSON.stringify(polling)}, 'polling');
      if (init.signal.aborted) cancel();
    });
  }
  if (url.endsWith('/oauth/token')) return Response.json(${JSON.stringify(token)});
  throw new Error('Unexpected fixture auth request');
};
`,
  );
  return { preload, allow, cancelled, polling, refreshToken };
}
