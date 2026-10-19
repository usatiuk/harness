export type ActionResult =
  { ok: true; message?: string; restartRequired?: boolean } | { ok: false; message: string };

export function ActionFeedback({ data }: { data: ActionResult | undefined }) {
  return data && "message" in data ? (
    <p role={data.ok ? "status" : "alert"} className={data.ok ? "muted" : "error"}>
      {data.message}
    </p>
  ) : null;
}
