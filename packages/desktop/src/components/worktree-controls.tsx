import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Check, GitBranch, Plus, Undo2 } from "lucide-react";
import type { Conversation, ManagedWorktree, WorkspaceSelection } from "@harness/protocol";
import type { DesktopSession } from "../session.ts";
import { Button, Checkbox, Confirmation, PopoverControl } from "../ui.tsx";

export function WorktreeControl({
  session,
  conversation,
  running,
  onSwitched,
}: {
  session: DesktopSession;
  conversation: Conversation;
  running: boolean;
  onSwitched?: () => void;
}) {
  const [options, setOptions] =
    useState<Awaited<ReturnType<DesktopSession["plugins"]["workspaceOptions"]>>>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let current = true;
    void session.plugins.workspaceOptions(conversation.id).then(
      (value) => {
        if (current) {
          setOptions(value);
          setError(undefined);
        }
      },
      (cause: unknown) => {
        if (current) {
          setOptions(undefined);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [session, conversation.id, conversation.workspaceRoot, refreshKey]);
  if (!conversation.workspaceRoot || options === null) return null;
  const branch = options?.worktrees.find((tree) => tree.path === options.current)?.branch;
  const originalSelected = options?.current === options?.original;
  const others =
    options?.worktrees.filter(
      (tree) => tree.path !== options.original && tree.path !== options.current,
    ) ?? [];
  const visible = showAll ? others : others.slice(0, originalSelected ? 5 : 4);
  const select = async (selection: WorkspaceSelection) => {
    setBusy(true);
    setError(undefined);
    try {
      await session.plugins.switchWorkspace(conversation.id, selection);
      setOptions(await session.plugins.workspaceOptions(conversation.id));
      await session.refreshSidebar();
      onSwitched?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PopoverControl
      label="Conversation workspace"
      align="start"
      onOpenChange={(open) => {
        if (open) {
          setShowAll(false);
          setRefreshKey((value) => value + 1);
        }
      }}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          className="conversation-branch"
          title={conversation.workspaceRoot}
        >
          <GitBranch size={12} aria-hidden="true" />
          {branch ?? "Workspace"}
        </Button>
      }
    >
      <div className="worktree-options">
        {options ? (
          <>
            <div className="worktree-current" title={options.current}>
              <Check size={16} aria-hidden="true" />
              <div>
                <strong>{branch ?? "Detached HEAD"}</strong>
                <span>{originalSelected ? "Original checkout" : "Current worktree"}</span>
              </div>
            </div>
            {others.length > 0 && (
              <div className="worktree-recent" aria-label="Recent worktrees">
                <span className="worktree-section-label">Recent worktrees</span>
                {visible.map((tree) => (
                  <Button
                    key={tree.path}
                    variant="ghost"
                    size="sm"
                    title={tree.path}
                    disabled={busy || running}
                    onClick={() => void select({ kind: "existing", path: tree.path })}
                  >
                    {tree.branch ?? "Detached HEAD"}
                  </Button>
                ))}
                {!showAll && others.length > visible.length && (
                  <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
                    Show all worktrees
                  </Button>
                )}
              </div>
            )}
            <div className="worktree-actions">
              <Button
                size="sm"
                disabled={busy || running || originalSelected}
                onClick={() => void select({ kind: "original" })}
              >
                <Undo2 size={13} aria-hidden="true" /> Original checkout
              </Button>
              <Button
                size="sm"
                disabled={busy || running}
                onClick={() => void select({ kind: "new" })}
              >
                <Plus size={13} aria-hidden="true" /> New worktree
              </Button>
            </div>
            {running && <span className="muted">Stop the conversation before switching.</span>}
          </>
        ) : (
          <span className="muted">Worktrees require an available Git repository.</span>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </PopoverControl>
  );
}

export function ManagedWorktrees({ session }: { session: DesktopSession }) {
  const [rows, setRows] = useState<ManagedWorktree[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<ManagedWorktree>();
  const load = async (before?: string) => {
    setBusy(true);
    try {
      const next = await session.plugins.managedWorktrees(20, before);
      setRows((old) => (before ? [...old, ...next] : next));
      setMore(next.length === 20);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let current = true;
    void session.plugins.managedWorktrees(20).then(
      (next) => {
        if (!current) return;
        setRows(next);
        setMore(next.length === 20);
        setBusy(false);
      },
      (cause: unknown) => {
        if (!current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      },
    );
    return () => {
      current = false;
    };
  }, [session]);
  return (
    <>
      <p className="muted">
        Managed checkouts on the selected server. Branches and conversation history are retained
        when a checkout is deleted.
      </p>
      {rows.map((tree) => (
        <div className="worktree-management-row" key={tree.path}>
          <span title={tree.repository}>{tree.path}</span>
          <Link to={`/new?cwd=${encodeURIComponent(tree.path)}`}>New conversation</Link>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(tree)}>
            Delete
          </Button>
        </div>
      ))}
      {!rows.length && !busy && <p className="muted">No managed worktrees.</p>}
      {more && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void load(rows.at(-1)?.path)}
        >
          Show more
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      <Confirmation
        title="Delete worktree?"
        description={`Delete ${deleting?.path ?? "this checkout"}, including any uncommitted and untracked files, and its Docker environment. Keep its branch and conversation history.`}
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        confirmLabel="Delete worktree"
        onConfirm={() => {
          const target = deleting;
          setDeleting(undefined);
          if (!target) return;
          setBusy(true);
          void session.plugins.removeWorktree(target.path, true).then(
            () => load(),
            (cause: unknown) => {
              setError(cause instanceof Error ? cause.message : String(cause));
              setBusy(false);
            },
          );
        }}
      />
    </>
  );
}

export function ManagedDockerEnvironments({ session }: { session: DesktopSession }) {
  const [rows, setRows] = useState<
    Awaited<ReturnType<DesktopSession["plugins"]["dockerEnvironments"]>>
  >([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const load = async (before?: string) => {
    setBusy(true);
    try {
      const next = await session.plugins.dockerEnvironments(20, before);
      setRows((old) => (before ? [...old, ...next] : next));
      setMore(next.length === 20);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let current = true;
    void session.plugins.dockerEnvironments(20).then(
      (next) => {
        if (!current) return;
        setRows(next);
        setMore(next.length === 20);
        setBusy(false);
      },
      (cause: unknown) => {
        if (!current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      },
    );
    return () => {
      current = false;
    };
  }, [session]);
  const control = async (id: string, action: "stop" | "remove") => {
    setBusy(true);
    setError(undefined);
    try {
      await session.plugins.controlDockerEnvironment(id, action);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h3>Docker environments</h3>
      <p className="muted">
        Stop preserves container state. Reopening a conversation starts its environment. Remove
        discards container state and keeps volumes.
      </p>
      {rows.map((row) => (
        <div className="worktree-management-row" key={row.id}>
          <span title={row.id}>
            {row.workspaceRoot ?? row.id} · {row.running ? "Running" : "Stopped"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !row.running}
            onClick={() => void control(row.id, "stop")}
          >
            Stop
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDeleting(row.id)}>
            Remove
          </Button>
        </div>
      ))}
      {!rows.length && !busy && !error && <p className="muted">No managed Docker environments.</p>}
      {more && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void load(rows.at(-1)?.id)}
        >
          Show more
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      <Confirmation
        title="Remove Docker environment?"
        description="Discard this environment's container state and stop its running commands. Workspace files, volumes, and conversation history are retained."
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        confirmLabel="Remove environment"
        onConfirm={() => {
          const id = deleting;
          setDeleting(undefined);
          if (id) void control(id, "remove");
        }}
      />
    </>
  );
}

export function NewWorktreeOption({ session, cwd }: { session: DesktopSession; cwd: string }) {
  const [result, setResult] = useState<{
    cwd: string;
    repository: string | null;
    error?: string;
  }>();
  const [selected, setSelected] = useState(false);
  useEffect(() => {
    let current = true;
    void session.plugins.worktreeRepository(cwd).then(
      (repository) => {
        if (current) setResult({ cwd, repository });
      },
      (cause: unknown) => {
        if (current)
          setResult({
            cwd,
            repository: null,
            error: cause instanceof Error ? cause.message : String(cause),
          });
      },
    );
    return () => {
      current = false;
    };
  }, [session, cwd]);
  const eligible = result?.cwd === cwd && result.repository !== null;
  return (
    <>
      <label className="check-label">
        <Checkbox
          name="newWorktree"
          disabled={!eligible}
          checked={eligible && selected}
          onChange={(event) => setSelected(event.currentTarget.checked)}
        />
        Start in a new Git worktree
      </label>
      {result?.cwd === cwd && result.error && <p role="alert">{result.error}</p>}
    </>
  );
}
