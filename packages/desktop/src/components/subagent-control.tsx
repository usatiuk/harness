import { memo, useEffect, useState } from "react";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import type { ConversationId } from "@harness/protocol";
import type { SubagentPage } from "@harness/client-features";
import type { ConversationSnapshot, DesktopSession } from "../session.ts";
import { Button } from "../ui.tsx";

const statusLabel = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  aborted: "Stopped",
};

function Children({
  session,
  id,
  revision,
  selected,
  onSelect,
}: {
  session: DesktopSession;
  id: string;
  revision: number;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [pages, setPages] = useState(1);
  const [data, setData] = useState<SubagentPage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const children: SubagentPage["children"] = [];
      let cursor: SubagentPage["nextCursor"] = null;
      let running = 0;
      for (let page = 0; page < pages; page++) {
        const next = await session.plugins.listSubagents(
          id as ConversationId,
          cursor,
          controller.signal,
        );
        children.push(...next.children);
        cursor = next.nextCursor;
        running = next.running;
        if (!cursor) break;
      }
      if (!controller.signal.aborted) {
        setData({ children, nextCursor: cursor, running });
        setError(undefined);
      }
    })()
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [session, id, revision, pages]);
  return (
    <ul>
      {data?.children.map((child) => (
        <li key={child.id}>
          <button
            type="button"
            className="subagent-row"
            aria-pressed={selected === child.id}
            onClick={() => onSelect(child.id)}
          >
            <span>{child.name}</span>
            <span className="muted" data-status={child.status}>
              {statusLabel[child.status]}
            </span>
          </button>
          {child.hasChildren && (
            <Children
              session={session}
              id={child.id}
              revision={revision}
              selected={selected}
              onSelect={onSelect}
            />
          )}
        </li>
      ))}
      {error && (
        <li className="error" role="alert">
          {error}
        </li>
      )}
      {!data && loading && (
        <li className="muted" role="status">
          Loading subagents…
        </li>
      )}
      {data?.children.length === 0 && <li className="muted">No subagents yet.</li>}
      {data?.nextCursor && (
        <li>
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setPages((count) => count + 1);
            }}
          >
            Show more
          </Button>
        </li>
      )}
    </ul>
  );
}

export function SubagentTree({
  session,
  rootId,
  rootLabel,
  revision,
  selected,
  onSelect,
}: {
  session: DesktopSession;
  rootId: string;
  rootLabel: string;
  revision: number;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="subagent-tree" aria-label="Conversation tree">
      <ul>
        <li>
          <div className="subagent-row">
            <span>{rootLabel}</span>
            <span className="muted">Main</span>
          </div>
          <Children
            key={rootId}
            session={session}
            id={rootId}
            revision={revision}
            selected={selected}
            onSelect={onSelect}
          />
        </li>
      </ul>
    </nav>
  );
}

export const SubagentHeading = memo(function SubagentHeading({
  subagent,
}: {
  subagent: NonNullable<ConversationSnapshot["subagent"]>;
}) {
  return (
    <div className="conversation-heading subagent-heading">
      <AncestorLinks ancestors={subagent.ancestors} />
      <ChevronRight size={14} aria-hidden="true" />
      <h1 title={subagent.slug}>{subagent.name}</h1>
    </div>
  );
});

function AncestorLinks({ ancestors }: { ancestors: { id: string; name: string }[] }) {
  return ancestors.map((ancestor, index) => (
    <span className="ancestor" key={ancestor.id}>
      {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
      <Link to={`/conversations/${ancestor.id}`}>{ancestor.name}</Link>
    </span>
  ));
}

export function ActivityOwner({ session, id }: { session: DesktopSession; id: string }) {
  const [identity, setIdentity] =
    useState<Awaited<ReturnType<DesktopSession["plugins"]["inspectSubagent"]>>>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    void session.plugins
      .inspectSubagent(id as ConversationId)
      .then((value) => {
        if (!disposed) setIdentity(value);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [session, id]);
  if (error)
    return (
      <span role="alert" className="error">
        {error}
      </span>
    );
  if (!identity) return null;
  return (
    <span className="activity-owner muted">
      <AncestorLinks ancestors={[...identity.ancestors, { id, name: identity.name }]} />
    </span>
  );
}
