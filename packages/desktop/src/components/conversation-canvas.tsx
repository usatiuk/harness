import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Virtuoso,
  type ContextProp,
  type ItemProps,
  type ListProps,
  type VirtuosoHandle,
} from "react-virtuoso";
import { Ellipsis } from "lucide-react";
import { IconButton } from "../ui.tsx";
import type { TranscriptRow } from "../transcript.ts";

interface CanvasContext {
  history: ReactNode;
  clearance: number;
  pendingWork?: ReactNode;
}
function HistoryHeader({ context }: { context?: CanvasContext }) {
  if (!context) throw new Error("Conversation transcript context is missing");
  return <div className="transcript-history">{context.history}</div>;
}
function ComposerClearance({ context }: { context?: CanvasContext }) {
  if (!context) throw new Error("Conversation transcript context is missing");
  return (
    <>
      {context.pendingWork}
      <div className="transcript-clearance" style={{ height: context.clearance }} />
    </>
  );
}

function TranscriptList({ children, ref, style }: ListProps) {
  return (
    <div ref={ref} style={style} className="transcript" data-testid="transcript">
      {children}
    </div>
  );
}

function TranscriptItem({
  item,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Virtuoso context must not reach the DOM.
  context: _context,
  ...props
}: ItemProps<TranscriptRow> & ContextProp<CanvasContext>) {
  return <div {...props} className="transcript-item" data-transcript-key={item.key} />;
}

const components = {
  Header: HistoryHeader,
  Footer: ComposerClearance,
  List: TranscriptList,
  Item: TranscriptItem,
};

export function ConversationCanvas({
  rows,
  running,
  header,
  history,
  dock,
  activityOverlay,
  renderRow,
  pendingWork,
}: {
  rows: TranscriptRow[];
  running: boolean;
  header: ReactNode;
  history: ReactNode;
  dock: ReactNode;
  activityOverlay?: ReactNode;
  renderRow: (row: TranscriptRow) => ReactNode;
  pendingWork?: ReactNode;
}) {
  const scroller = useRef<VirtuosoHandle>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [scrollParent, setScrollParent] = useState<HTMLElement | Window | null>(null);
  const [clearance, setClearance] = useState(0);
  const [gutter, setGutter] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const firstKey = rows[0]?.key;
  // Virtuoso needs positive index headroom for older history.
  const [start, setStart] = useState({ key: firstKey, index: 1_000_000 });
  if (start.key !== firstKey) {
    const prepended = rows.findIndex((row) => row.key === start.key);
    setStart({ key: firstKey, index: start.index - Math.max(0, prepended) });
  }

  useLayoutEffect(() => {
    const element = dockRef.current;
    if (!element || !(scrollParent instanceof HTMLElement)) return;
    const measure = () => {
      setClearance(element.offsetHeight + 12);
      setGutter(scrollParent.offsetWidth - scrollParent.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(scrollParent);
    return () => observer.disconnect();
  }, [scrollParent]);

  return (
    <div className="conversation-page">
      <div className="conversation-header-wrap">{header}</div>
      <Virtuoso
        className="conversation-scroll"
        scrollerRef={setScrollParent}
        firstItemIndex={start.index}
        ref={scroller}
        data={rows}
        context={{ history, clearance, pendingWork }}
        computeItemKey={(_index, row) => row.key}
        initialTopMostItemIndex={{ index: "LAST", align: "end" }}
        followOutput="auto"
        skipAnimationFrameInResizeObserver
        atBottomThreshold={12}
        atBottomStateChange={setAtBottom}
        components={components}
        itemContent={(_index, row) => renderRow(row)}
      />
      <div className="conversation-dock-layout" style={{ marginRight: gutter }}>
        <div className="conversation-dock-overlays">
          {running && !atBottom && rows.length > 0 && (
            <IconButton
              label="Jump to latest"
              icon={Ellipsis}
              className="jump-latest"
              onClick={() => scroller.current?.scrollToIndex({ index: "LAST", align: "end" })}
            />
          )}
          {activityOverlay}
        </div>
        <div className="conversation-dock">
          <div className="conversation-dock-content" ref={dockRef}>
            {dock}
          </div>
        </div>
      </div>
    </div>
  );
}
