import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { isKernelEvent, type ConversationId } from "@harness/protocol";
import type { DesktopSession, ConversationView, ConversationSnapshot } from "../session.ts";
import { Button, IconButton, Tabs } from "../ui.tsx";
import { SubagentTree } from "./subagent-control.tsx";
import { ChangesView } from "./changes-view.tsx";

function SideConversation({
  session,
  id,
  render,
}: {
  session: DesktopSession;
  id: string;
  render: (attachment: ConversationView) => ReactNode;
}) {
  const [attachment, setAttachment] = useState<ConversationView>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    void session
      .load(id)
      .then((value) => {
        if (!disposed) setAttachment(value);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [session, id]);
  return error ? (
    <p role="alert" className="error">
      {error}
    </p>
  ) : attachment ? (
    render(attachment)
  ) : (
    <p className="muted" role="status">
      Loading conversation…
    </p>
  );
}

type SidebarWidths = Partial<Record<"panel" | "tree", number>>;
// Presentation-only memory survives router/session replacement, not app restart.
const rememberedWidths = new Map<string, SidebarWidths>();

export function RightSidebarLayout({
  session,
  view,
  label,
  renderConversation,
  children,
}: {
  session: DesktopSession;
  view: ConversationSnapshot;
  label: string;
  renderConversation: (attachment: ConversationView) => ReactNode;
  children: (toggle: ReactNode) => ReactNode;
}) {
  const ancestor = view.subagent?.ancestors[0];
  const rootId = ancestor?.id ?? view.conversation.id;
  const widthKey = session.storageKey(`sidebar-widths:${rootId}`);
  const widths = rememberedWidths.get(widthKey);
  const rememberWidth = (kind: keyof SidebarWidths, width: number) =>
    rememberedWidths.set(widthKey, { ...rememberedWidths.get(widthKey), [kind]: width });
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("changes");
  const [resizedWidth, setWidth] = useState(widths?.panel);
  const [treeWidth, setTreeWidth] = useState(widths?.tree);
  const resizePanel = (width: number) => {
    setWidth(width);
    rememberWidth("panel", width);
  };
  const resizeTree = (width: number) => {
    setTreeWidth(width);
    rememberWidth("tree", width);
  };
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [layoutWidth, setLayoutWidth] = useState(window.innerWidth);
  const layout = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setLayoutWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const maxWidth = Math.max(320, layoutWidth - 320);
  const width = Math.min(
    maxWidth,
    resizedWidth ?? Math.max(320, Math.min(720, Math.round(viewportWidth * 0.4))),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string>();
  useEffect(() => {
    if (!selected) return;
    let disposed = false;
    const unsubscribe = session.plugins.subscribe(rootId as ConversationId, (event) => {
      if (isKernelEvent(event) || event.type !== "subagents.changed") return;
      // History remains accessible; only the navigator's live selection follows
      // the always-visible family root when its branch leaves the roster.
      void session
        .load(selected)
        .then((attachment) => {
          if (disposed) return;
          const branch = [...(attachment.subagent?.ancestors ?? []), { id: selected }];
          const index = branch.findIndex((ancestor) => ancestor.id === event["dismissedId"]);
          if (index >= 0) {
            setSelected(null);
            setSelectionError(undefined);
          }
        })
        .catch((cause: unknown) => {
          if (!disposed) setSelectionError(cause instanceof Error ? cause.message : String(cause));
        });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [session, rootId, selected]);
  const toggle = (
    <IconButton
      icon={open ? PanelRightClose : PanelRightOpen}
      label={open ? "Hide right sidebar" : "Show right sidebar"}
      aria-expanded={open}
      className="right-sidebar-toggle chrome-control"
      size="sm"
      onClick={() => setOpen((value) => !value)}
    />
  );
  return (
    <div
      ref={layout}
      className="right-sidebar-layout"
      style={{ "--right-sidebar-width": `${width}px` } as CSSProperties}
    >
      <div className="main-conversation">{children(open ? null : toggle)}</div>
      <aside className="right-sidebar" aria-label="Right sidebar" hidden={!open}>
        <div
          className="right-sidebar-resize"
          role="separator"
          aria-label="Resize right sidebar"
          aria-orientation="vertical"
          aria-valuemin={320}
          aria-valuemax={maxWidth}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              resizePanel(
                Math.max(
                  320,
                  Math.min(
                    maxWidth,
                    event.currentTarget.parentElement!.getBoundingClientRect().right -
                      event.clientX,
                  ),
                ),
              );
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              resizePanel(
                Math.max(320, Math.min(maxWidth, width + (event.key === "ArrowLeft" ? 10 : -10))),
              );
            }
          }}
        />
        <Tabs.Root value={tab} onValueChange={setTab} className="right-sidebar-tabs">
          <div className="right-sidebar-header">
            <Tabs.List aria-label="Right sidebar views">
              <Tabs.Trigger value="changes" asChild>
                <Button variant="ghost" size="sm">
                  Changes
                </Button>
              </Tabs.Trigger>
              <Tabs.Trigger value="subagents" asChild>
                <Button variant="ghost" size="sm">
                  Subagents
                </Button>
              </Tabs.Trigger>
            </Tabs.List>
            {toggle}
          </div>
          <Tabs.Content value="changes" forceMount hidden={tab !== "changes"}>
            {open && (
              <ChangesView
                key={rootId}
                session={session}
                conversationId={rootId}
                workspace={view.conversation.workspaceRoot}
                treeWidth={treeWidth}
                setTreeWidth={resizeTree}
                active={tab === "changes" && !session.disconnected}
              />
            )}
          </Tabs.Content>
          <Tabs.Content value="subagents" forceMount hidden={tab !== "subagents"}>
            {open && (
              <>
                <SubagentTree
                  key={rootId}
                  session={session}
                  rootId={rootId}
                  rootLabel={ancestor?.name ?? label}
                  revision={view.subagentRevision}
                  selected={selected}
                  onSelect={setSelected}
                />
                <div className="side-conversation">
                  {selectionError && (
                    <p className="error" role="alert">
                      {selectionError}
                    </p>
                  )}
                  {selected ? (
                    <SideConversation
                      key={selected}
                      session={session}
                      id={selected}
                      render={renderConversation}
                    />
                  ) : (
                    <p className="muted">Select a conversation.</p>
                  )}
                </div>
              </>
            )}
          </Tabs.Content>
        </Tabs.Root>
      </aside>
    </div>
  );
}
