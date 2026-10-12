import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { NavLink, Link, useLocation } from "react-router";
import { PanelLeftClose, PanelLeftOpen, Plus, Settings, X, ChevronDown } from "lucide-react";
import { z } from "zod";
import type { Conversation } from "@harness/protocol";
import type { DesktopSession, SidebarPage } from "../session.ts";
import { Button, IconButton } from "../ui.tsx";

const layoutSchema = z.object({ width: z.number().min(160).max(400), visible: z.boolean() });
const groupsSchema = z.object({ hidden: z.array(z.string()), collapsed: z.array(z.string()) });
function readLayout() {
  try {
    return layoutSchema.parse(JSON.parse(localStorage.getItem("sidebar-layout") ?? "null"));
  } catch {
    return { width: 220, visible: true };
  }
}
function readGroups(key: string) {
  try {
    return groupsSchema.parse(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return { hidden: [] as string[], collapsed: [] as string[] };
  }
}
const folderName = (path: string) => path.split(/[/\\]/u).filter(Boolean).at(-1) ?? path;

function More<T, Cursor>({ page, load }: { page: SidebarPage<T, Cursor>; load: () => void }) {
  return (
    <>
      {page.error && (
        <p role="alert" className="sidebar-error">
          {page.error}
        </p>
      )}
      {(page.cursor !== null || page.error) && (
        <Button
          variant="ghost"
          size="sm"
          className="sidebar-more"
          disabled={page.loading}
          onClick={load}
        >
          {page.error ? "Retry" : "Show more"}
        </Button>
      )}
      {page.loading && <span className="muted sidebar-loading">Loading…</span>}
    </>
  );
}

function ProjectGroup({
  session,
  root,
  label,
  collapsed,
  toggle,
  hide,
  renderConversation,
}: {
  session: DesktopSession;
  root: string;
  label: string;
  collapsed: boolean;
  toggle: (open: boolean) => void;
  hide: () => void;
  renderConversation: (conversation: Conversation) => ReactNode;
}) {
  const page = session.projectPages.get(root);
  useEffect(() => {
    if (!collapsed && !page) void session.loadProject(root);
  }, [session, root, collapsed, page]);
  return (
    <details
      className="sidebar-project"
      open={!collapsed}
      onToggle={(event) => toggle(event.currentTarget.open)}
    >
      <summary title={root}>
        <span className="project-label">{label}</span>
        <IconButton
          label={`Hide project ${label}`}
          icon={X}
          size="sm"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            hide();
          }}
        />
        <ChevronDown className="sidebar-chevron" size={12} aria-hidden="true" />
      </summary>
      {!collapsed && page && (
        <div className="project-conversations">
          {page.rows.map(renderConversation)}
          <More
            page={page}
            load={() => {
              void session.loadProject(root, page.loaded);
            }}
          />
        </div>
      )}
    </details>
  );
}

export function SidebarLayout({
  session,
  controls,
  renderConversation,
  children,
}: {
  session: DesktopSession;
  controls: ReactNode;
  renderConversation: (conversation: Conversation) => ReactNode;
  children: ReactNode;
}) {
  const location = useLocation();
  const storageKey = session.storageKey("sidebar-groups");
  const [layout, setLayout] = useState(readLayout);
  const [groups, setGroups] = useState(() => readGroups(storageKey));
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const root = useRef<HTMLDivElement>(null);
  const maximum = Math.max(160, Math.min(400, viewportWidth - 320));
  const width = Math.min(layout.width, maximum);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    localStorage.setItem("sidebar-layout", JSON.stringify(layout));
  }, [layout]);
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(groups));
  }, [storageKey, groups]);
  useEffect(() => {
    const match = /^\/conversations\/([^/]+)$/u.exec(location.pathname);
    const workspace = match
      ? session.views.get(decodeURIComponent(match[1]!) as Conversation["id"])?.conversation
          .workspaceRoot
      : undefined;
    if (workspace)
      // Router navigation reveals a hidden folder while preserving its collapse preference.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGroups((current) =>
        current.hidden.includes(workspace)
          ? { ...current, hidden: current.hidden.filter((path) => path !== workspace) }
          : current,
      );
  }, [location.key, location.pathname, session]);
  const collapse = (key: string, open: boolean) =>
    setGroups((current) => {
      if (current.collapsed.includes(key) === !open) return current;
      return {
        ...current,
        collapsed: open
          ? current.collapsed.filter((entry) => entry !== key)
          : [...current.collapsed, key],
      };
    });
  const resize = (next: number) =>
    setLayout((current) => ({ ...current, width: Math.max(160, Math.min(maximum, next)) }));
  const names = new Map<string, number>();
  for (const project of session.projects.rows)
    names.set(
      folderName(project.workspaceRoot),
      (names.get(folderName(project.workspaceRoot)) ?? 0) + 1,
    );
  return (
    <div
      className={`app ${layout.visible ? "" : "sidebar-hidden"}`}
      ref={root}
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}
    >
      <aside className="sidebar" hidden={!layout.visible}>
        <div className="sidebar-heading">
          {controls}
          <Link
            to="/new"
            className="new-conversation"
            aria-label="New conversation"
            title="New conversation"
          >
            <Plus size={15} aria-hidden="true" />
          </Link>
          <IconButton
            label="Hide sidebar"
            icon={PanelLeftClose}
            onClick={() => setLayout((current) => ({ ...current, visible: false }))}
          />
        </div>
        <nav aria-label="Conversations" className="conversation-list">
          <details
            className="sidebar-section sidebar-projects"
            open={!groups.collapsed.includes("projects")}
            onToggle={(event) => collapse("projects", event.currentTarget.open)}
          >
            <summary>
              <span>Projects</span>
              <ChevronDown className="sidebar-chevron" size={12} aria-hidden="true" />
            </summary>
            {session.projects.rows
              .filter((project) => !groups.hidden.includes(project.workspaceRoot))
              .map((project) => {
                const name = folderName(project.workspaceRoot);
                const label = names.get(name)! > 1 ? project.workspaceRoot : name;
                return (
                  <ProjectGroup
                    key={project.workspaceRoot}
                    session={session}
                    root={project.workspaceRoot}
                    label={label}
                    collapsed={groups.collapsed.includes(project.workspaceRoot)}
                    toggle={(open) => collapse(project.workspaceRoot, open)}
                    hide={() =>
                      setGroups((current) => ({
                        ...current,
                        hidden: [...current.hidden, project.workspaceRoot],
                      }))
                    }
                    renderConversation={renderConversation}
                  />
                );
              })}
            <More
              page={session.projects}
              load={() => {
                void session.loadProjects(session.projects.loaded);
              }}
            />
          </details>
          <details
            className="sidebar-section sidebar-recents"
            open={!groups.collapsed.includes("recents")}
            onToggle={(event) => collapse("recents", event.currentTarget.open)}
          >
            <summary>
              <span>Recents</span>
              <ChevronDown className="sidebar-chevron" size={12} aria-hidden="true" />
            </summary>
            {session.recents.rows.map(renderConversation)}
            <More
              page={session.recents}
              load={() => {
                void session.list(session.recents.loaded);
              }}
            />
          </details>
        </nav>
        <NavLink to="/settings" className="settings-link">
          <Settings size={15} aria-hidden="true" /> Settings
        </NavLink>
        <div
          className="sidebar-resize"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={160}
          aria-valuemax={maximum}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              resize(event.clientX - root.current!.getBoundingClientRect().left);
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
          onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              resize(
                event.key === "Home"
                  ? 160
                  : event.key === "End"
                    ? maximum
                    : width + (event.key === "ArrowLeft" ? -10 : 10),
              );
            }
          }}
        />
      </aside>
      {!layout.visible && (
        <IconButton
          label="Show sidebar"
          icon={PanelLeftOpen}
          className="sidebar-show"
          size="sm"
          onClick={() => setLayout((current) => ({ ...current, visible: true }))}
        />
      )}
      {children}
    </div>
  );
}
