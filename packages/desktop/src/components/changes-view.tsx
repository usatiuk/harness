import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronRight } from "lucide-react";
import type { ChangeFile, ChangeMode, ChangesPage } from "@harness/client-features";
import type { ConversationId } from "@harness/protocol";
import type { DesktopSession } from "../session.ts";
import { Button, CollapsibleDetails, Select, SelectItem } from "../ui.tsx";
import { CHANGES_HEADER_HEIGHT, ChangesDiff, type ChangesDiffHandle } from "./changes-diff.tsx";

import { ChangeFileInfo } from "./change-file-info.tsx";

interface Folder {
  name: string;
  folders: Map<string, Folder>;
  files: ChangeFile[];
}
function fileTree(files: ChangeFile[]): Folder {
  const root: Folder = { name: "", folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let folder = root;
    for (const name of parts.slice(0, -1)) {
      let next = folder.folders.get(name);
      if (!next) {
        next = { name, folders: new Map(), files: [] };
        folder.folders.set(name, next);
      }
      folder = next;
    }
    folder.files.push(file);
  }
  return root;
}
interface FolderRowsProps {
  folder: Folder;
  selected: string | null;
  select: (file: ChangeFile) => void;
}
function FolderRow({ folder, selected, select }: FolderRowsProps) {
  const [open, setOpen] = useState(true);
  return (
    <CollapsibleDetails
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="changes-folder"
      summary={
        <summary>
          <ChevronRight size={14} className="disclosure-chevron" aria-hidden="true" />
          <span>{folder.name}</span>
        </summary>
      }
    >
      <FolderRows folder={folder} selected={selected} select={select} />
    </CollapsibleDetails>
  );
}
function FolderRows({ folder, selected, select }: FolderRowsProps) {
  return (
    <>
      {[...folder.folders.values()].map((child) => (
        <FolderRow key={child.name} folder={child} selected={selected} select={select} />
      ))}
      {folder.files.map((file) => (
        <button
          type="button"
          className="changes-file"
          key={file.path}
          title={file.path}
          aria-pressed={file.path === selected}
          onClick={() => select(file)}
        >
          <span>{file.path.split("/").at(-1)}</span>
          <ChangeFileInfo file={file} />
        </button>
      ))}
    </>
  );
}

export function ChangesView({
  session,
  conversationId,
  active,
  workspace,
}: {
  session: DesktopSession;
  conversationId: string;
  active: boolean;
  workspace: string | null;
}) {
  const id = conversationId as ConversationId;
  const [mode, setMode] = useState<ChangeMode>("uncommitted");
  const [treeHeight, setTreeHeight] = useState<number>();
  const [treeWidth, setTreeWidth] = useState<number>();
  return (
    <div
      className="changes-view"
      style={
        {
          "--changes-header-height": `${CHANGES_HEADER_HEIGHT}px`,
          "--changes-tree-height": treeHeight === undefined ? undefined : `${treeHeight}px`,
          "--changes-tree-width": treeWidth === undefined ? undefined : `${treeWidth}px`,
        } as CSSProperties
      }
    >
      <ChangesComparison
        key={`${id}:${mode}:${workspace}`}
        session={session}
        id={id}
        mode={mode}
        setMode={setMode}
        setTreeHeight={setTreeHeight}
        setTreeWidth={setTreeWidth}
        active={active}
      />
    </div>
  );
}

function ChangesComparison({
  session,
  id,
  mode,
  setMode,
  setTreeHeight,
  setTreeWidth,
  active,
}: {
  session: DesktopSession;
  id: ConversationId;
  mode: ChangeMode;
  setMode: (mode: ChangeMode) => void;
  setTreeHeight: (height: number) => void;
  setTreeWidth: (width: number) => void;
  active: boolean;
}) {
  const [page, setPage] = useState<ChangesPage>();
  const [pages, setPages] = useState(1);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string | null>(null);
  const scroller = useRef<ChangesDiffHandle>(null);
  const [treeLayout, setTreeLayout] = useState({
    height: 40,
    width: 210,
    available: 160,
    availableWidth: 0,
  });
  const treePane = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setTreeLayout({
        height: element.getBoundingClientRect().height,
        width: element.getBoundingClientRect().width,
        available: element.parentElement!.clientHeight,
        availableWidth: element.parentElement!.clientWidth,
      }),
    );
    observer.observe(element);
    observer.observe(element.parentElement!);
    return () => observer.disconnect();
  }, []);
  const wideTree = treeLayout.availableWidth >= 560;
  const minTreeSize = wideTree ? 140 : 40;
  const maxTreeSize = Math.max(
    minTreeSize,
    wideTree ? treeLayout.availableWidth - 245 : treeLayout.available - 120,
  );
  const resizeTree = (size: number) =>
    (wideTree ? setTreeWidth : setTreeHeight)(Math.max(minTreeSize, Math.min(maxTreeSize, size)));
  const [split, setSplit] = useState(false);
  const diffPane = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setSplit(entry.contentRect.width >= 640);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active || session.disconnected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // The open Changes tab reconciles external edits too, without a filesystem
    // watcher or overlapping requests. Hidden panels do no Git polling.
    const refresh = async () => {
      try {
        let after: string | null = null;
        const files: ChangeFile[] = [];
        let next: ChangesPage | undefined;
        for (let index = 0; index < pages; index++) {
          next = await session.plugins.listChanges(id, mode, after, controller.signal);
          files.push(...next.files);
          after = next.nextCursor;
          if (!after) break;
        }
        if (!controller.signal.aborted && next) {
          const value = { ...next, files };
          setPage((previous) =>
            JSON.stringify(previous) === JSON.stringify(value) ? previous : value,
          );
          setError(undefined);
          timer = setTimeout(() => {
            void refresh();
          }, 2000);
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [session, id, mode, pages, active]);
  const files = page?.files;
  const tree = useMemo(() => fileTree(files ?? []), [files]);
  const select = (file: ChangeFile) => {
    setSelected(file.path);
    scroller.current?.jump(file.path);
  };
  return (
    <div className="changes-content">
      <nav ref={treePane} className="changes-files" aria-label="Changed files">
        <div className="changes-comparison">
          <Select
            aria-label="Change comparison"
            value={mode}
            onValueChange={(value) => setMode(value as ChangeMode)}
          >
            <SelectItem value="uncommitted">Uncommitted</SelectItem>
            <SelectItem value="unstaged">Unstaged</SelectItem>
            <SelectItem value="staged">Staged</SelectItem>
            <SelectItem value="branch">Against {page?.defaultBranch ?? "main/master"}</SelectItem>
            <SelectItem value="unpushed">Unpushed</SelectItem>
          </Select>
          {mode === "unpushed" && page?.upstream && (
            <span className="muted" title={page.upstream}>
              {page.upstream}
            </span>
          )}
        </div>
        <div className="changes-file-list">
          {page && <FolderRows folder={tree} selected={selected} select={select} />}
          {page?.nextCursor && (
            <Button size="sm" variant="ghost" onClick={() => setPages((value) => value + 1)}>
              Show more files
            </Button>
          )}
        </div>
      </nav>
      <div
        className="changes-tree-resize"
        role="separator"
        aria-label="Resize changed file tree"
        aria-orientation={wideTree ? "vertical" : "horizontal"}
        aria-valuemin={minTreeSize}
        aria-valuemax={maxTreeSize}
        aria-valuenow={Math.round(wideTree ? treeLayout.width : treeLayout.height)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            const tree = event.currentTarget.previousElementSibling!.getBoundingClientRect();
            resizeTree(wideTree ? tree.right - event.clientX : event.clientY - tree.top);
          }
        }}
        onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        onKeyDown={(event) => {
          const increase = wideTree ? "ArrowLeft" : "ArrowDown";
          const decrease = wideTree ? "ArrowRight" : "ArrowUp";
          if (event.key === increase || event.key === decrease) {
            event.preventDefault();
            resizeTree(
              (wideTree ? treeLayout.width : treeLayout.height) +
                (event.key === increase ? 10 : -10),
            );
          }
        }}
      />
      <div className="changes-diffs" aria-label="File diffs" ref={diffPane}>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!page && !error && (
          <p className="muted" role="status">
            Loading changes…
          </p>
        )}
        {page?.unavailable ? (
          <p className="muted">{page.unavailable}</p>
        ) : page && page.files.length === 0 ? (
          <p className="muted">No changes.</p>
        ) : (
          page && (
            <ChangesDiff
              ref={scroller}
              session={session}
              id={id}
              mode={mode}
              files={page.files}
              active={active}
              split={split}
              loadMore={() => {
                if (page.nextCursor) setPages((value) => value + 1);
              }}
            />
          )
        )}
      </div>
    </div>
  );
}
