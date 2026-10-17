import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ChevronRight, Network } from "lucide-react";
import type { ConversationId } from "@harness/protocol";
import type { SubagentPage, SubagentRow } from "@harness/client-features";
import type { ConversationView, DesktopSession } from "../session.ts";
import { Button, IconButton, PopoverControl } from "../ui.tsx";

const statusLabel = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  aborted: "Stopped",
};

function useSubagents(
  session: DesktopSession,
  id: string,
  activityRevision: unknown,
  refreshKey = 0,
) {
  const [pages, setPages] = useState(1);
  const [data, setData] = useState<SubagentPage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const children: SubagentRow[] = [];
      let cursor: SubagentPage["nextCursor"] = null;
      let running = 0;
      for (let index = 0; index < pages; index++) {
        const page = await session.plugins.listSubagents(
          id as ConversationId,
          cursor,
          controller.signal,
        );
        children.push(...page.children);
        running = page.running;
        cursor = page.nextCursor;
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
  }, [session, id, pages, activityRevision, refreshKey]);
  return {
    data,
    error,
    loading,
    more: () => {
      setLoading(true);
      setPages((count) => count + 1);
    },
  };
}

function Tree({
  session,
  id,
  revision,
}: {
  session: DesktopSession;
  id: string;
  revision: unknown;
}) {
  const state = useSubagents(session, id, revision);
  return <TreeRows session={session} revision={revision} state={state} />;
}
function TreeRows({
  session,
  revision,
  state,
  grouped = false,
}: {
  session: DesktopSession;
  revision: unknown;
  state: ReturnType<typeof useSubagents>;
  grouped?: boolean;
}) {
  const rows = (children: SubagentRow[]) =>
    children.map((child) => {
      const title = (
        <>
          <Link to={`/conversations/${child.id}`} title={`${child.slug} · ${child.agent}`}>
            {child.name}
          </Link>
          <span className="muted" data-status={child.status}>
            {statusLabel[child.status]}
          </span>
        </>
      );
      return (
        <div key={child.id}>
          <div className="subagent-row">{title}</div>
          {child.hasChildren && <Tree session={session} id={child.id} revision={revision} />}
        </div>
      );
    });
  const children = state.data?.children ?? [];
  return (
    <div className="subagent-tree">
      {grouped
        ? [true, false].map((running) => {
            const branch = children.filter((child) => child.running > 0 === running);
            return (
              branch.length > 0 && (
                <section key={String(running)} aria-label={running ? "Running" : "Finished"}>
                  <h3>{running ? "Running" : "Finished"}</h3>
                  {rows(branch)}
                </section>
              )
            );
          })
        : rows(children)}
      {state.error && (
        <p role="alert" className="error">
          {state.error}
        </p>
      )}
      {!state.data && state.loading && (
        <p className="muted" role="status">
          Loading subagents…
        </p>
      )}
      {state.data?.children.length === 0 && <p className="muted">No subagents yet.</p>}
      {state.data?.nextCursor && (
        <Button size="sm" variant="ghost" disabled={state.loading} onClick={state.more}>
          Show more
        </Button>
      )}
    </div>
  );
}

export function SubagentControl({
  session,
  view,
}: {
  session: DesktopSession;
  view: ConversationView;
}) {
  const [refresh, setRefresh] = useState(0);
  const state = useSubagents(session, view.conversation.id, view.subagentRevision, refresh);
  const running = state.data?.running ?? 0;
  return (
    <div className="subagent-control">
      <PopoverControl
        className="subagent-popover"
        label="Subagents"
        onOpenChange={(open) => {
          if (open) setRefresh((value) => value + 1);
        }}
        trigger={
          running ? (
            <Button variant="ghost" size="sm" aria-label={`Subagents · ${running} running`}>
              <Network size={14} />
              Subagents · {running} running
            </Button>
          ) : (
            <IconButton icon={Network} size="sm" label="Subagents" />
          )
        }
      >
        <h2>Subagents</h2>
        <TreeRows session={session} revision={view.subagentRevision} state={state} grouped />
      </PopoverControl>
    </div>
  );
}

export function SubagentHeading({ view }: { view: ConversationView }) {
  if (!view.subagent) throw new Error("Subagent heading requires subagent metadata");
  return (
    <div className="conversation-heading subagent-heading">
      <AncestorLinks ancestors={view.subagent.ancestors} />
      <ChevronRight size={14} aria-hidden="true" />
      <h1 title={view.subagent.slug}>{view.subagent.name}</h1>
    </div>
  );
}

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
