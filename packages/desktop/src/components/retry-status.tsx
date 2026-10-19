import type { ReactElement } from "react";
import { retryStatusLabel, type RetryStatus } from "@harness/client-features/transcript-reducer";

/** Transient retry progress while a model call backs off. */
export function RetryStatusLine({ retry }: { retry: RetryStatus }): ReactElement {
  return (
    <div className="cell" role="status">
      <div className="work-group-title">{retryStatusLabel(retry)}</div>
    </div>
  );
}
