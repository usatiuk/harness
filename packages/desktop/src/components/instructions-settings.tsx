import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { z } from "zod";
import type { appInstructionsRequest } from "@harness/server/client-protocol";
import { Button, Input, Textarea } from "../ui.tsx";
import { ActionFeedback, type ActionResult } from "./action-feedback.tsx";

export type InstructionsReadResult =
  | { ok: true; document: z.output<typeof appInstructionsRequest.result> }
  | { ok: false; message: string };

export function InstructionsSettings({
  active,
  disconnected,
}: {
  active: boolean;
  disconnected: boolean;
}) {
  const read = useFetcher<InstructionsReadResult>();
  const save = useFetcher<ActionResult>();
  const [text, setText] = useState<string>();
  useEffect(() => {
    if (active && !disconnected && !read.data && read.state === "idle")
      void read.load("/instructions");
  }, [active, disconnected, read]);
  if (text === undefined && read.data?.ok) setText(read.data.document.content ?? "");
  const document = read.data?.ok ? read.data.document : undefined;
  return (
    <>
      <div className="section-heading">
        <h2>Global instructions</h2>
        <p className="muted">
          Edit this host’s AGENTS.md. Applies to new or reloaded conversations.
        </p>
      </div>
      {read.data && !read.data.ok && (
        <>
          <ActionFeedback data={read.data} />
          <Button
            disabled={disconnected || read.state !== "idle"}
            onClick={() => void read.load("/instructions")}
          >
            Retry loading instructions
          </Button>
        </>
      )}
      {document ? (
        <save.Form
          method="post"
          action="/actions"
          className="form-grid form-single-column"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            // Keep unchanged file line endings; textarea DOM values normalize them.
            data.set("content", text ?? "");
            void save.submit(data, { method: "post", action: "/actions" });
          }}
        >
          <Input type="hidden" name="intent" value="instructions" />
          <p className="muted">{document.path}</p>
          {document.content === null && <p className="muted">No file yet. Save to create it.</p>}
          <label>
            AGENTS.md
            <Textarea
              name="content"
              value={text ?? ""}
              rows={16}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={disconnected || save.state !== "idle"}>
            {save.state === "idle" ? "Save instructions" : "Saving…"}
          </Button>
          <ActionFeedback data={save.data} />
        </save.Form>
      ) : read.state !== "idle" ? (
        <p role="status">Loading instructions…</p>
      ) : null}
    </>
  );
}
