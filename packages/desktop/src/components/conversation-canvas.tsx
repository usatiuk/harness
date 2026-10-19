import {
  Component,
  createRef,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Virtuoso, type ContextProp, type ItemProps, type VirtuosoHandle } from "react-virtuoso";
import { Ellipsis } from "lucide-react";
import { IconButton } from "../ui.tsx";
import type { TranscriptRow } from "../transcript.ts";

interface CanvasContext {
  history: ReactNode;
  clearance: number;
  pendingWork?: ReactNode;
  scrollParent: HTMLElement;
  dock: RefObject<HTMLDivElement | null>;
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

interface AnchorProps {
  rows: TranscriptRow[];
  children: (firstItemIndex: number) => ReactNode;
}
interface AnchorState {
  rows: TranscriptRow[];
  firstItemIndex: number;
}
type Anchor = {
  element: HTMLElement;
  boundaries: { parent: HTMLElement; offset: number }[];
};
function restoreAnchor(anchor: Anchor): void {
  if (!anchor.element.isConnected) return;
  // The inner group consumes only its available scroll range; the page absorbs
  // the remainder when the group grows below or across its height cap.
  for (const { parent, offset } of anchor.boundaries) {
    const viewport = parent.getBoundingClientRect();
    const scale = viewport.height / parent.offsetHeight;
    parent.scrollTop +=
      (anchor.element.getBoundingClientRect().top - viewport.top) / scale - offset;
  }
}

/** Keep Virtuoso's measured row identities aligned when history is prepended. */
class HistoryAnchor extends Component<AnchorProps, AnchorState> {
  // Virtuoso needs positive index headroom when the total older history is unknown.
  override state: AnchorState = { rows: this.props.rows, firstItemIndex: 1_000_000 };

  static getDerivedStateFromProps(props: AnchorProps, state: AnchorState): AnchorState | null {
    if (props.rows === state.rows) return null;
    const previousFirst = state.rows[0];
    const prepended = previousFirst
      ? props.rows.findIndex((row) => row.key === previousFirst.key)
      : 0;
    return {
      rows: props.rows,
      firstItemIndex: state.firstItemIndex - Math.max(0, prepended),
    };
  }

  override render() {
    return this.props.children(this.state.firstItemIndex);
  }
}

type RowAnchorProps = ItemProps<TranscriptRow> & ContextProp<CanvasContext>;

/** Observe the row commit, not the parent data update preceding Virtuoso's render. */
class HistoryRowAnchor extends Component<RowAnchorProps> {
  private readonly element = createRef<HTMLDivElement>();
  private pendingAnchor: Anchor | null = null;
  override getSnapshotBeforeUpdate(previous: RowAnchorProps): Anchor | null {
    const first = previous.item;
    const next = this.props.item;
    if (first.kind !== "steps" || next.kind !== "steps" || first.steps[0].key === next.steps[0].key)
      return null;
    const viewport = this.props.context.scrollParent.getBoundingClientRect();
    const dockTop = this.props.context.dock.current?.getBoundingClientRect().top ?? viewport.bottom;
    for (const element of this.element.current!.querySelectorAll<HTMLElement>(
      ".work-items > *, .cell.tool",
    )) {
      if (element.closest("[inert]")) continue;
      const parent =
        element.closest<HTMLElement>(".tool-group-container") ?? this.props.context.scrollParent;
      const clip = parent.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const top = Math.max(viewport.top, clip.top);
      const bottom = Math.min(viewport.bottom, dockTop, clip.bottom);
      if (rect.height > 0 && rect.bottom > top && rect.top < bottom) {
        const parents =
          parent === this.props.context.scrollParent
            ? [parent]
            : [parent, this.props.context.scrollParent];
        return {
          element,
          boundaries: parents.map((parent) => {
            const clip = parent.getBoundingClientRect();
            const scale = clip.height / parent.offsetHeight;
            return { parent, offset: (rect.top - clip.top) / scale };
          }),
        };
      }
    }
    return null;
  }

  override componentDidUpdate(
    _previous: RowAnchorProps,
    _state: unknown,
    anchor: Anchor | null,
  ): void {
    if (anchor) this.pendingAnchor = anchor;
    // Restore only once Virtuoso has committed this item's measured size. A
    // premature page scroll can unmount the row before its measurement arrives.
    if (
      this.pendingAnchor &&
      this.props["data-known-size"] === this.element.current!.getBoundingClientRect().height
    ) {
      restoreAnchor(this.pendingAnchor);
      this.pendingAnchor = null;
    }
  }

  override render() {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Virtuoso context must not reach the DOM.
    const { item, context: _context, ...props } = this.props;
    return (
      <div {...props} className="transcript-item" data-transcript-key={item.key} ref={this.element}>
        {props.children}
      </div>
    );
  }
}

const components = { Header: HistoryHeader, Footer: ComposerClearance, Item: HistoryRowAnchor };

export function ConversationCanvas({
  rows,
  running,
  header,
  history,
  dock,
  renderRow,
  pendingWork,
}: {
  rows: TranscriptRow[];
  running: boolean;
  header: ReactNode;
  history: ReactNode;
  dock: ReactNode;
  renderRow: (row: TranscriptRow) => ReactNode;
  pendingWork?: ReactNode;
}) {
  const scroller = useRef<VirtuosoHandle>(null);
  const dockRef = useRef<HTMLDivElement>(null);
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
      <div className="conversation-header-wrap">{header}</div>
      <div
        className="conversation-scroll"
        ref={setScrollParent}
        onClickCapture={(event) => {
          const summary = event.target instanceof Element ? event.target.closest("summary") : null;
          if (
            summary &&
            scrollParent &&
            scrollParent.scrollHeight - scrollParent.clientHeight - scrollParent.scrollTop <= 4 &&
            !summary.parentElement!.hasAttribute("open")
          )
            scroller.current?.autoscrollToBottom();
        }}
      >
        <div className="transcript" data-testid="transcript">
          {scrollParent && (
            <HistoryAnchor rows={rows}>
              {(firstItemIndex) => (
                <Virtuoso
                  firstItemIndex={firstItemIndex}
                  skipAnimationFrameInResizeObserver
                  ref={scroller}
                  customScrollParent={scrollParent}
                  data={rows}
                  context={{ history, clearance, pendingWork, scrollParent, dock: dockRef }}
                  itemSize={(element) => element.getBoundingClientRect().height}
                  computeItemKey={(_index, row) => row.key}
                  initialTopMostItemIndex={{ index: "LAST", align: "end" }}
                  followOutput="auto"
                  atBottomStateChange={setAtBottom}
                  components={components}
                  itemContent={(_index, row) => renderRow(row)}
                />
              )}
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
