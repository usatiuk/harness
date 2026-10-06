import {
  Component,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Ellipsis } from "lucide-react";
import { IconButton } from "../ui.tsx";
import type { TranscriptRow } from "../transcript.ts";

interface CanvasContext {
  history: ReactNode;
  clearance: number;
}
function HistoryHeader({ context }: { context?: CanvasContext }) {
  if (!context) throw new Error("Conversation transcript context is missing");
  return <div className="transcript-history">{context.history}</div>;
}
function ComposerClearance({ context }: { context?: CanvasContext }) {
  if (!context) throw new Error("Conversation transcript context is missing");
  return <div className="transcript-clearance" style={{ height: context.clearance }} />;
}
const components = { Header: HistoryHeader, Footer: ComposerClearance };

interface AnchorProps {
  rows: TranscriptRow[];
  scrollParent: HTMLElement;
  header: RefObject<HTMLDivElement | null>;
  dock: RefObject<HTMLDivElement | null>;
  scroller: RefObject<VirtuosoHandle | null>;
  children: ReactNode;
}
type Anchor = { index: number; offset: number };

/** Capture the reader's latest position before a history prepend changes DOM. */
class HistoryAnchor extends Component<AnchorProps> {
  override getSnapshotBeforeUpdate(previous: AnchorProps): Anchor | null {
    if (!previous.rows.length || previous.rows[0]?.key === this.props.rows[0]?.key) return null;
    const parent = this.props.scrollParent;
    const viewport = parent.getBoundingClientRect();
    const scale = viewport.height / parent.offsetHeight;
    const top = viewport.top + (this.props.header.current?.getBoundingClientRect().height ?? 0);
    const bottom = Math.min(
      viewport.bottom,
      this.props.dock.current?.getBoundingClientRect().top ?? viewport.bottom,
    );
    const indices = new Map(this.props.rows.map((row, index) => [row.key, index]));
    const elements = [...parent.querySelectorAll<HTMLElement>("[data-transcript-key]")];
    const visible = elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > top && rect.top < bottom;
    });
    const element = visible.find((row) => indices.has(row.dataset.transcriptKey!));
    if (element)
      return {
        index: indices.get(element.dataset.transcriptKey!)!,
        offset: (element.getBoundingClientRect().top - viewport.top) / scale,
      };
    // A newly loaded parent may absorb every rendered standalone child. Its
    // collapsed row is the nearest remaining representation of that content.
    const first = visible[0];
    const previousRow = previous.rows.find((row) => row.key === first?.dataset.transcriptKey);
    if (first && previousRow?.cell.kind === "tool" && previousRow.cell.parentCallId) {
      const parentCallId = previousRow.cell.parentCallId;
      const index = this.props.rows.findIndex(
        (row) => row.cell.kind === "tool" && row.cell.callId === parentCallId,
      );
      if (index >= 0)
        return { index, offset: (first.getBoundingClientRect().top - viewport.top) / scale };
    }
    const nearest = elements
      .filter((row) => indices.has(row.dataset.transcriptKey!))
      .sort(
        (left, right) =>
          Math.abs(left.getBoundingClientRect().top - top) -
          Math.abs(right.getBoundingClientRect().top - top),
      )[0];
    if (nearest)
      return {
        index: indices.get(nearest.dataset.transcriptKey!)!,
        offset: (nearest.getBoundingClientRect().top - viewport.top) / scale,
      };
    return null;
  }
  override componentDidUpdate(
    _previous: AnchorProps,
    _state: unknown,
    anchor: Anchor | null,
  ): void {
    if (anchor)
      this.props.scroller.current?.scrollToIndex({
        index: anchor.index,
        align: "start",
        offset: -anchor.offset,
      });
  }
  override render() {
    return this.props.children;
  }
}

export function ConversationCanvas({
  rows,
  running,
  header,
  history,
  dock,
  renderRow,
}: {
  rows: TranscriptRow[];
  running: boolean;
  header: ReactNode;
  history: ReactNode;
  dock: ReactNode;
  renderRow: (row: TranscriptRow) => ReactNode;
}) {
  const scroller = useRef<VirtuosoHandle>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const [clearance, setClearance] = useState(0);
  const [gutter, setGutter] = useState(0);
  const [atBottom, setAtBottom] = useState(true);

  useLayoutEffect(() => {
    const element = dockRef.current;
    if (!element || !scrollParent) return;
    let measuredHeight = -1;
    const measure = () => {
      const nextHeight = element.offsetHeight + 12;
      if (nextHeight !== measuredHeight) {
        // Arm the virtualizer before its footer grows. Follow only if the reader
        // is currently at the bottom; support/draft growth must not pull them away.
        if (scrollParent.scrollHeight - scrollParent.clientHeight - scrollParent.scrollTop <= 4)
          scroller.current?.autoscrollToBottom();
        measuredHeight = nextHeight;
        setClearance(nextHeight);
      }
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
      <div className="conversation-scroll" ref={setScrollParent}>
        <div className="conversation-header-wrap" ref={headerRef}>
          {header}
        </div>
        <div className="transcript" data-testid="transcript">
          {scrollParent && (
            <HistoryAnchor
              rows={rows}
              scrollParent={scrollParent}
              header={headerRef}
              dock={dockRef}
              scroller={scroller}
            >
              <Virtuoso
                ref={scroller}
                customScrollParent={scrollParent}
                data={rows}
                context={{ history, clearance }}
                computeItemKey={(_index, row) => row.key}
                initialTopMostItemIndex={{ index: "LAST", align: "end" }}
                followOutput={atBottom ? "auto" : false}
                atBottomStateChange={setAtBottom}
                components={components}
                itemContent={(_index, row) => (
                  <div className="transcript-item" data-transcript-key={row.key}>
                    {renderRow(row)}
                  </div>
                )}
              />
            </HistoryAnchor>
          )}
        </div>
      </div>
      <div className="conversation-dock" style={{ right: gutter }}>
        {running && !atBottom && rows.length > 0 && (
          <IconButton
            label="Jump to latest"
            icon={Ellipsis}
            className="jump-latest"
            onClick={() => scroller.current?.scrollToIndex({ index: "LAST", align: "end" })}
          />
        )}
        <div className="conversation-dock-content" ref={dockRef}>
          {dock}
        </div>
      </div>
    </div>
  );
}
