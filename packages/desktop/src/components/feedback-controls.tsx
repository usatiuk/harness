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
import { Button, Input } from "../ui.tsx";

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
  const refresh = () => {
    reads.delete(session);
    void readCached(session)
      .then(setStatus)
      .catch(() => setError("Feedback settings unavailable"));
  };
  useEffect(refresh, [session]);
  return (
    <section>
      <h2>Learning feedback</h2>
      <p>Send voted execution evidence to your MAI controller. No training starts from a vote.</p>
      {status && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const endpoint = data.get("endpoint"),
              tokenEnv = data.get("tokenEnv");
            if (typeof endpoint !== "string" || typeof tokenEnv !== "string") {
              setError("Missing feedback settings");
              return;
            }
            void session.client.peer
              .request(feedbackConfigureRequest, {
                enabled: data.get("enabled") === "on",
                endpoint,
                tokenEnv,
              })
              .then(refresh)
              .catch(() => setError("Could not save feedback settings"));
          }}
        >
          <label>
            <input type="checkbox" name="enabled" defaultChecked={status.enabled} /> Enable thumbs
            up/down
          </label>
          <label>
            MAI endpoint
            <Input name="endpoint" type="url" defaultValue={status.endpoint} required />
          </label>
          <label>
            Token environment variable
            <Input name="tokenEnv" defaultValue={status.tokenEnv} required />
          </label>
          <p>
            Set that variable in the Harness server environment. Votes appear when enabled and a
            token is available. Reopen the conversation after changing settings.
          </p>
          <Button type="submit">Save feedback settings</Button>
          <Button
            type="button"
            onClick={() =>
              void session.client.peer
                .request(feedbackRetryRequest, {})
                .then(refresh)
                .catch(() => setError("Retry failed"))
            }
          >
            Retry queued delivery
          </Button>
          <p role="status">
            {status.pending} queued · {status.failed} delivery failures ·{" "}
            {status.configured ? "Token configured" : "Token missing"}
          </p>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
