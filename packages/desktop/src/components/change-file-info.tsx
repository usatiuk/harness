import type { ChangeFile } from "@harness/client-features";

export function ChangeFileInfo({ file }: { file: ChangeFile }) {
  return (
    <>
      <span className="muted">{file.status}</span>
      {file.additions === null || file.deletions === null ? (
        <span className="muted" title="Line counts unavailable">
          —
        </span>
      ) : (
        <>
          <span className="changes-additions">+{file.additions}</span>
          <span className="changes-deletions">−{file.deletions}</span>
        </>
      )}
    </>
  );
}
