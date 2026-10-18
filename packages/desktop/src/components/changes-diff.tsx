import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { processPatch, type CodeViewDiffItem, type FileDiffMetadata } from "@pierre/diffs";
import type { ChangeFile, ChangeMode, FileDiff } from "@harness/client-features";
import type { ConversationId } from "@harness/protocol";
import type { DesktopSession } from "../session.ts";
import { ChevronRight } from "lucide-react";
import { ChangeFileInfo } from "./change-file-info.tsx";
import { useAppearance, useDiffPreferences, setDiffPreferences } from "../appearance.ts";
import { ContextMenu } from "../ui.tsx";

// 32px select + 6px top/bottom padding + 1px bottom border.
export const CHANGES_HEADER_HEIGHT = 45;

export interface ChangesDiffHandle {
  jump(path: string): void;
}
interface CachedDiff {
  value?: FileDiff;
  error?: string;
  item: CodeViewDiffItem<string>;
}
function emptyDiff(file: ChangeFile): FileDiffMetadata {
  return {
    name: file.path,
    ...(file.previousPath ? { prevName: file.previousPath } : {}),
    type: "change",
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
    lang: "text",
  };
}
function loadedDiff(file: ChangeFile, value: FileDiff, version: number): CodeViewDiffItem<string> {
  const raw = /^diff --(?:cc|combined) |^@@@/m.test(value.patch);
  const parsed = !raw && value.patch ? processPatch(value.patch, undefined, true).files : [];
  if (!raw && value.patch && parsed.length !== 1)
    throw new Error("Expected one file in a Git diff");
  return {
    id: file.path,
    type: "diff",
    version,
    fileDiff: parsed.length ? { ...parsed[0]!, name: file.path, lang: "text" } : emptyDiff(file),
    ...(raw ? { annotations: [{ side: "additions", lineNumber: 0, metadata: value.patch }] } : {}),
  };
}

export function ChangesDiff({
  session,
  id,
  mode,
  files,
  active,
  split,
  loadMore,
  ref,
}: {
  session: DesktopSession;
  id: ConversationId;
  mode: ChangeMode;
  files: ChangeFile[];
  active: boolean;
  split: boolean;
  loadMore: () => void;
  ref?: Ref<ChangesDiffHandle>;
}) {
  const viewer = useRef<CodeViewHandle<string, undefined>>(null);
  const appearance = useAppearance();
  const preferences = useDiffPreferences();
  const [cache, setCache] = useState(new Map<string, CachedDiff>());
  // Each toggle contributes to the item version: CodeView only accepts changed
  // item options when its version changes, including collapsed state.
  const [toggles, setToggles] = useState(new Map<string, number>());
  const filesByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const fileMap = useRef(new Map<string, ChangeFile>());
  const pump = useRef<() => void>(() => {});
  const priority = useRef<string | undefined>(undefined);
  useEffect(() => {
    fileMap.current = filesByPath;
    pump.current();
  }, [filesByPath]);
  useEffect(() => {
    if (!active || session.disconnected) return;
    const controller = new AbortController();
    const running = new Set<string>();
    const readAt = new Map<string, number>();
    // Requests and patches belong to this comparison, never to virtual DOM rows.
    // Keep remote work bounded; a clicked file precedes nearby prefetch reads.
    const refresh = () => {
      if (controller.signal.aborted) return;
      const paths = [...fileMap.current.keys()];
      const wanted = new Set(priority.current ? [priority.current] : []);
      for (const item of viewer.current?.getInstance()?.getRenderedItems() ?? []) {
        const index = paths.indexOf(item.id);
        wanted.add(item.id);
        if (index > 0) wanted.add(paths[index - 1]!);
        if (index >= 0 && index + 1 < paths.length) wanted.add(paths[index + 1]!);
      }
      for (const path of wanted) {
        if (running.size >= 4) break;
        const file = fileMap.current.get(path);
        if (!file || running.has(path) || Date.now() - (readAt.get(path) ?? -Infinity) < 2000)
          continue;
        running.add(path);
        void session.plugins
          .readChangeDiff(id, mode, file, controller.signal)
          .then((value) => {
            if (controller.signal.aborted) return;
            readAt.set(path, Date.now());
            setCache((previous) => {
              const old = previous.get(path);
              if (
                !old?.error &&
                old?.value?.patch === value.patch &&
                old.value.unavailable === value.unavailable
              )
                return previous;
              const item = loadedDiff(file, value, (old?.item.version ?? 0) + 1);
              return new Map(previous).set(path, { value, item });
            });
          })
          .catch((cause: unknown) => {
            if (controller.signal.aborted) return;
            readAt.set(path, Infinity);
            setCache((previous) =>
              new Map(previous).set(path, {
                ...previous.get(path),
                item: previous.get(path)?.item ?? {
                  id: path,
                  type: "diff",
                  fileDiff: emptyDiff(file),
                  version: 0,
                },
                error: cause instanceof Error ? cause.message : String(cause),
              }),
            );
          })
          .finally(() => {
            running.delete(path);
            if (priority.current === path) priority.current = undefined;
            refresh();
          });
      }
    };
    pump.current = refresh;
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      controller.abort();
      clearInterval(timer);
      pump.current = () => {};
    };
  }, [session, id, mode, active]);
  useEffect(() => {
    if (!split) return;
    const element = viewer.current?.getInstance()?.getContainerElement();
    if (!element) return;
    const selectSide = (event: PointerEvent) => {
      const code = event
        .composedPath()
        .find(
          (node): node is HTMLElement =>
            node instanceof HTMLElement &&
            node.matches("[data-code][data-additions], [data-code][data-deletions]"),
        );
      const root = code?.getRootNode();
      if (root instanceof ShadowRoot)
        root.host.setAttribute(
          "data-copy-side",
          code!.hasAttribute("data-additions") ? "additions" : "deletions",
        );
    };
    element.addEventListener("pointerdown", selectSide);
    return () => element.removeEventListener("pointerdown", selectSide);
  }, [split]);
  useImperativeHandle(
    ref,
    () => ({
      jump(path) {
        setToggles((previous) => {
          const count = previous.get(path) ?? 0;
          return count % 2 ? new Map(previous).set(path, count + 1) : previous;
        });
        priority.current = path;
        viewer.current?.scrollTo({ type: "item", id: path, align: "start", behavior: "instant" });
        pump.current();
      },
    }),
    [],
  );
  const items = useMemo(
    () =>
      files.map((file): CodeViewDiffItem<string> => {
        const item = cache.get(file.path)?.item ?? {
          id: file.path,
          type: "diff" as const,
          version: 0,
          fileDiff: emptyDiff(file),
        };
        const count = toggles.get(file.path) ?? 0;
        return { ...item, collapsed: count % 2 === 1, version: (item.version ?? 0) + count };
      }),
    [files, cache, toggles],
  );
  const options = useMemo(
    () => ({
      themeType: appearance.theme,
      unsafeCSS: `
        :host { --diffs-light: var(--ink); --diffs-dark: var(--ink); }
        [data-code] { user-select: text; -webkit-user-select: text; }
        [data-column-number] { user-select: none; -webkit-user-select: none; }
        [data-overflow="wrap"], [data-overflow="scroll"] [data-code] { container-type: inline-size; }
        [data-deletions] [data-gutter] { z-index: 4; }
        [data-gutter] [data-separator="metadata"] [data-separator-wrapper] {
          inset-inline: 0 auto;
          width: 100cqi;
          min-width: 0;
          padding-inline: 12px;
          z-index: 4;
        }
        [data-code]::-webkit-scrollbar-thumb { background-color: var(--muted-ink); }
        @supports (-moz-appearance: none) {
          [data-code] { scrollbar-color: var(--muted-ink) transparent; }
        }
        :host([data-copy-side="additions"]) [data-diff-type="split"] [data-code][data-deletions],
        :host([data-copy-side="deletions"]) [data-diff-type="split"] [data-code][data-additions] {
          user-select: none; -webkit-user-select: none;
        }
      `,
      diffStyle: split ? ("split" as const) : ("unified" as const),
      stickyHeaders: true,
      itemMetrics: { diffHeaderHeight: CHANGES_HEADER_HEIGHT },
      layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
      overflow: preferences.wordWrap ? ("wrap" as const) : ("scroll" as const),
      disableLineNumbers: !preferences.lineNumbers,
      lineDiffType: "none" as const,
      diffIndicators: "none" as const,
      hunkSeparators: "metadata" as const,
      disableErrorHandling: true,
      onPostRender(
        node: HTMLElement,
        _instance: unknown,
        phase: string,
        context: { item: { id: string } },
      ) {
        if (phase === "unmount") return;
        node.setAttribute("role", "region");
        node.setAttribute("aria-label", context.item.id);
        queueMicrotask(() => pump.current());
      },
    }),
    [split, appearance.theme, preferences],
  );
  const onScroll = useCallback(() => {
    pump.current();
    const element = viewer.current?.getInstance()?.getContainerElement();
    if (element && element.scrollTop + element.clientHeight >= element.scrollHeight - 800)
      loadMore();
  }, [loadMore]);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="changes-diff-context" tabIndex={0} aria-label="Diff viewer">
          <CodeView
            ref={viewer}
            items={items}
            options={options}
            className={`changes-diff-scroll ${preferences.wordWrap ? "" : "changes-diff-no-wrap"}`}
            onScroll={onScroll}
            renderCustomHeader={(item) => {
              const file = filesByPath.get(item.id);
              // A list update can remove a file before CodeView retires its old slot.
              if (!file) return null;
              const entry = cache.get(item.id);
              const status =
                entry?.error ?? entry?.value?.unavailable ?? (entry ? "" : "Loading diff…");
              return (
                <button
                  type="button"
                  className="change-file-header"
                  data-file-path={item.id}
                  aria-expanded={!item.collapsed}
                  aria-label={`${item.collapsed ? "Expand" : "Collapse"} ${item.id}`}
                  onClick={() =>
                    setToggles((previous) =>
                      new Map(previous).set(item.id, (previous.get(item.id) ?? 0) + 1),
                    )
                  }
                >
                  <ChevronRight size={14} className="disclosure-chevron" aria-hidden="true" />
                  <span className="change-file-name" title={item.id}>
                    {item.type === "diff" && item.fileDiff.prevName
                      ? `${item.fileDiff.prevName} → ${item.id}`
                      : item.id}
                  </span>
                  <ChangeFileInfo file={file} />
                  {status && (
                    <span className={entry?.error ? "error" : "muted"} title={status}>
                      {status}
                    </span>
                  )}
                </button>
              );
            }}
            renderAnnotation={(annotation) => (
              <pre className="change-patch-raw">{annotation.metadata}</pre>
            )}
          />
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Content aria-label="Diff display options">
        <ContextMenu.CheckboxItem
          checked={preferences.wordWrap}
          onCheckedChange={(checked) =>
            setDiffPreferences({ ...preferences, wordWrap: checked === true })
          }
        >
          Word wrap
        </ContextMenu.CheckboxItem>
        <ContextMenu.CheckboxItem
          checked={preferences.lineNumbers}
          onCheckedChange={(checked) =>
            setDiffPreferences({ ...preferences, lineNumbers: checked === true })
          }
        >
          Line numbers
        </ContextMenu.CheckboxItem>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
