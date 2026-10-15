import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  feedbackStatusRequest,
  feedbackVoteRequest,
  feedbackConfigureRequest,
  feedbackRetryRequest,
} from "@harness/feedback/client";
import type { DesktopSession } from "../session.ts";
import { Button, Checkbox, Input } from "../ui.tsx";

type Status = Awaited<ReturnType<typeof readStatus>>;
function readStatus(session: DesktopSession) {
  return session.client.peer.request(feedbackStatusRequest, {});
}
const reads = new WeakMap<DesktopSession, Promise<Status>>();
function readCached(session: DesktopSession) {
  let pending = reads.get(session);
  if (!pending) {
    pending = readStatus(session);
    reads.set(session, pending);
    void pending.catch(() => reads.delete(session));
  }
  return pending;
}

export function FeedbackControls({
  session,
  itemId,
}: {
  session: DesktopSession;
  itemId: string | undefined;
}) {
  const { id } = useParams();
  const [status, setStatus] = useState<Status>();
  const [vote, setVote] = useState<"up" | "down">();
  const [comment, setComment] = useState("");
  const [result, setResult] = useState<{ id: string; status: string; url: string }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [identity] = useState(() => crypto.randomUUID());
  useEffect(() => {
    void readCached(session).then(setStatus, () => setStatus(undefined));
  }, [session]);
  if (!itemId || !id || !status?.enabled || !status.configured) return null;
  return (
    <div className="feedback-controls">
      {!result && (
        <>
          <Button variant="ghost" onClick={() => setVote("up")} aria-pressed={vote === "up"}>
            Thumbs up
          </Button>
          <Button variant="ghost" onClick={() => setVote("down")} aria-pressed={vote === "down"}>
            Thumbs down
          </Button>
          {vote && (
            <>
              <Input
                aria-label="Optional feedback comment"
                placeholder="Optional comment"
                value={comment}
                disabled={busy}
                onChange={(event) => setComment(event.target.value)}
              />
              <Button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void session.client.peer
                    .request(feedbackVoteRequest, {
                      id: identity,
                      conversationId: id,
                      itemId,
                      vote,
                      comment,
                    })
                    .then(setResult)
                    .catch(() =>
                      setError(
                        "Could not confirm feedback. Retry with the same comment; the case ID is preserved.",
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Save feedback
              </Button>
            </>
          )}
        </>
      )}
      {result && (
        <>
          <span role="status">
            Feedback{" "}
            {result.status === "delivered" ? "delivered" : "saved locally; queued for delivery"}.
          </span>
          <Button
            variant="ghost"
            onClick={() => void openUrl(result.url).catch(() => setError("Could not open MAI"))}
          >
            Open case in MAI
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function FeedbackSettings({ session }: { session: DesktopSession }) {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const refresh = async () => {
    reads.delete(session);
    setStatus(await readCached(session));
  };
  useEffect(() => {
    reads.delete(session);
    void readCached(session).then(setStatus, () => setError("Feedback settings unavailable"));
  }, [session]);
  async function update(action: () => Promise<unknown>, saving = false) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await action();
      await refresh();
      setSaved(saving);
    } catch {
      setError("Could not update feedback settings. Check the server connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="section-heading">
        <h2>Learning feedback</h2>
        <p className="muted">Send thumbs up/down and the relevant execution to MAI for review.</p>
      </div>
      {status ? (
        <>
          <form
            className="form-grid composer-settings"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const endpoint = data.get("endpoint"),
                tokenEnv = data.get("tokenEnv");
              if (typeof endpoint !== "string" || typeof tokenEnv !== "string") {
                setError("Missing feedback connection settings");
                return;
              }
              void update(
                () =>
                  session.client.peer.request(feedbackConfigureRequest, {
                    enabled: data.get("enabled") === "on",
                    endpoint,
                    tokenEnv,
                  }),
                true,
              );
            }}
          >
            <label className="check-label">
              <Checkbox name="enabled" defaultChecked={status.enabled} disabled={busy} />
              Show feedback buttons in conversations
            </label>
            <label>
              MAI address
              <Input
                name="endpoint"
                type="url"
                defaultValue={status.endpoint}
                required
                disabled={busy}
              />
              <small className="muted">
                Reachable from the Harness server, such as http://127.0.0.1:7331.
              </small>
            </label>
            <details>
              <summary>Connection details</summary>
              <label>
                Token environment variable
                <Input name="tokenEnv" defaultValue={status.tokenEnv} required disabled={busy} />
              </label>
              <p className="muted">
                Set this variable in the Harness server environment, then restart the server. The
                token itself stays out of settings.
              </p>
            </details>
            <Button type="submit" variant="accent" disabled={busy || Boolean(session.disconnected)}>
              {busy ? "Please wait…" : "Save feedback settings"}
            </Button>
          </form>
          <p className="muted" role="status">
            {saved && "Saved. Reopen the conversation to update its feedback buttons. "}
            {status.configured
              ? "Token available"
              : "Token missing — set the environment variable above"}
            {` · ${status.pending} queued · ${status.failed} delivery failures`}
          </p>
          <Button
            variant="ghost"
            disabled={busy || !status.pending}
            onClick={() => void update(() => session.client.peer.request(feedbackRetryRequest, {}))}
          >
            Retry queued delivery
          </Button>
          <p className="muted">
            A vote saves a feedback case. Teachers and training start separately in MAI.
          </p>
        </>
      ) : (
        !error && <p className="muted">Loading feedback settings…</p>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
