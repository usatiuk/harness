import { useMemo, Fragment, type ReactElement, type ReactNode } from "react";
import { Box, Text, useWindowSize } from "ink";
import { marked, type Token, type Tokens } from "marked";
import { highlight } from "./markdown-highlight.ts";

interface Ctx {
  /** Columns for full-width elements (rules, tables); shrinks inside nesting. */
  width: number;
  /** Reasoning output: mute to dim and drop colors. */
  dim: boolean;
  /** Whole message complete — every fence is closed and safe to highlight. */
  finalized: boolean;
}

/**
 * Streams markdown (GFM) as Ink nodes. While `streaming` the trailing partial line is held
 * raw (line-commit) so half-typed syntax never flashes formatted; fences highlight only once
 * closed or finalized.
 */
export function Markdown({
  text,
  streaming = false,
  dim = false,
}: {
  text: string;
  streaming?: boolean;
  dim?: boolean;
}): ReactElement {
  const { columns } = useWindowSize();
  const width = Math.max(20, Math.min(columns, 100));
  const cut = streaming ? lastNewline(text) : text.length;
  const committed = streaming ? text.slice(0, cut) : text;
  const tail = streaming ? text.slice(cut) : "";
  const tokens = useMemo(() => marked.lexer(committed), [committed]);
  // Tokens only change when a line commits, so the committed blocks are reused (and React
  // skips reconciling them) while the tail grows delta to delta.
  const blocks = useMemo(
    () => renderBlocks(tokens, { width, dim, finalized: !streaming }),
    [tokens, width, dim, streaming],
  );
  return (
    <Box flexDirection="column">
      {blocks}
      {tail ? <Text dimColor={dim}>{tail}</Text> : null}
    </Box>
  );
}

function lastNewline(s: string): number {
  const i = s.lastIndexOf("\n");
  return i === -1 ? 0 : i + 1;
}

// `exactOptionalPropertyTypes` forbids color={undefined}; omit the key instead.
const colorProps = (c?: string): { color?: string } => (c ? { color: c } : {});

/** Shared Text styling: dim mode mutes everything and suppresses color. */
function textStyle(ctx: Ctx, color?: string): { dimColor: boolean; color?: string } {
  return { dimColor: ctx.dim, ...colorProps(ctx.dim ? undefined : color) };
}

function renderBlocks(tokens: Token[], ctx: Ctx): ReactElement[] {
  const out: ReactElement[] = [];
  tokens.forEach((tok, i) => {
    const closed = ctx.finalized || i !== tokens.length - 1;
    const el = renderBlock(tok, i, ctx, closed);
    if (el) out.push(el);
  });
  return out;
}

function renderBlock(
  token: Token,
  key: number,
  ctx: Ctx,
  codeClosed: boolean,
): ReactElement | null {
  switch (token.type) {
    case "space":
      return <Box key={key} height={1} />;
    case "heading": {
      const h = token as Tokens.Heading;
      return (
        <Box key={key}>
          <Text bold {...textStyle(ctx, h.depth <= 2 ? "cyan" : undefined)}>
            {renderInline(h.tokens, ctx, `h${key}`)}
          </Text>
        </Box>
      );
    }
    case "paragraph": {
      const p = token as Tokens.Paragraph;
      return (
        <Box key={key}>
          <Text {...textStyle(ctx)}>{renderInline(p.tokens, ctx, `p${key}`)}</Text>
        </Box>
      );
    }
    case "text": {
      const t = token as Tokens.Text;
      return (
        <Text key={key} {...textStyle(ctx)}>
          {t.tokens && t.tokens.length ? renderInline(t.tokens, ctx, `x${key}`) : t.text}
        </Text>
      );
    }
    case "blockquote": {
      const bq = token as Tokens.Blockquote;
      return (
        <Box
          key={key}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor="gray"
          paddingLeft={1}
        >
          <Box flexDirection="column">
            {renderBlocks(bq.tokens, { ...ctx, width: Math.max(10, ctx.width - 2) })}
          </Box>
        </Box>
      );
    }
    case "list": {
      const l = token as Tokens.List;
      const start = typeof l.start === "number" ? l.start : 1;
      return (
        <Box key={key} flexDirection="column">
          {l.items.map((item, idx) => {
            const marker = l.ordered ? `${start + idx}. ` : "• ";
            const check = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
            const gutter = marker + check;
            // The checkbox is drawn in the gutter; drop marked's checkbox token.
            const children = item.tokens.filter((c) => c.type !== "checkbox");
            return (
              <Box key={idx}>
                <Text {...textStyle(ctx, "cyan")}>{gutter}</Text>
                <Box flexDirection="column">
                  {renderBlocks(children, {
                    ...ctx,
                    width: Math.max(10, ctx.width - gutter.length),
                  })}
                </Box>
              </Box>
            );
          })}
        </Box>
      );
    }
    case "code": {
      const c = token as Tokens.Code;
      return <CodeBlock key={key} code={c.text} lang={c.lang} closed={codeClosed} dim={ctx.dim} />;
    }
    case "table":
      return renderTable(token as Tokens.Table, key, ctx);
    case "hr":
      return (
        <Text key={key} dimColor>
          {"─".repeat(ctx.width)}
        </Text>
      );
    case "html":
      return (
        <Text key={key} dimColor>
          {(token as Tokens.HTML).text}
        </Text>
      );
    default:
      return null;
  }
}

function CodeBlock({
  code,
  lang,
  closed,
  dim,
}: {
  code: string;
  lang: string | undefined;
  closed: boolean;
  dim: boolean;
}): ReactElement {
  const lines = closed && !dim ? highlight(code, lang) : null;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {lines
        ? lines.map((line, i) => (
            <Text key={i}>
              {line.map((tok, j) => (
                <Text key={j} {...colorProps(tok.color)}>
                  {tok.content}
                </Text>
              ))}
            </Text>
          ))
        : code.split("\n").map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
    </Box>
  );
}

function renderTable(t: Tokens.Table, key: number, ctx: Ctx): ReactElement {
  const cols = t.header.length;
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = plainText(t.header[c]?.tokens).length;
    for (const row of t.rows) w = Math.max(w, plainText(row[c]?.tokens).length);
    widths.push(Math.max(1, w));
  }
  const total = widths.reduce((a, w) => a + w + 2, 0);
  return (
    <Box key={key} flexDirection="column">
      <Box>
        {t.header.map((cell, c) => tableCell(cell, widths[c] ?? 1, t.align[c], ctx, true, c))}
      </Box>
      <Text dimColor>{"─".repeat(Math.min(total, ctx.width))}</Text>
      {t.rows.map((row, r) => (
        <Box key={r}>
          {row.map((cell, c) => tableCell(cell, widths[c] ?? 1, t.align[c], ctx, false, c))}
        </Box>
      ))}
    </Box>
  );
}

function tableCell(
  cell: Tokens.TableCell | undefined,
  w: number,
  align: "center" | "left" | "right" | null | undefined,
  ctx: Ctx,
  header: boolean,
  key: number,
): ReactElement {
  const justify = align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start";
  return (
    <Box key={key} width={w + 2} justifyContent={justify}>
      <Text bold={header} {...textStyle(ctx, header ? "cyan" : undefined)}>
        {cell ? renderInline(cell.tokens, ctx, `c${key}`) : ""}
      </Text>
    </Box>
  );
}

function renderInline(tokens: Token[] | undefined, ctx: Ctx, kp: string): ReactNode {
  if (!tokens) return null;
  return tokens.map((t, i) => {
    const k = `${kp}.${i}`;
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        return (
          <Fragment key={k}>
            {tt.tokens && tt.tokens.length ? renderInline(tt.tokens, ctx, k) : tt.text}
          </Fragment>
        );
      }
      case "strong":
        return (
          <Text key={k} bold {...textStyle(ctx)}>
            {renderInline((t as Tokens.Strong).tokens, ctx, k)}
          </Text>
        );
      case "em":
        return (
          <Text key={k} italic {...textStyle(ctx)}>
            {renderInline((t as Tokens.Em).tokens, ctx, k)}
          </Text>
        );
      case "del":
        return (
          <Text key={k} strikethrough {...textStyle(ctx)}>
            {renderInline((t as Tokens.Del).tokens, ctx, k)}
          </Text>
        );
      case "codespan":
        return (
          <Text key={k} {...textStyle(ctx, "yellow")}>
            {(t as Tokens.Codespan).text}
          </Text>
        );
      case "br":
        return <Fragment key={k}>{"\n"}</Fragment>;
      case "link": {
        const lt = t as Tokens.Link;
        const showUrl = !!lt.href && lt.href !== plainText(lt.tokens);
        return (
          <Text key={k}>
            <Text underline {...textStyle(ctx, "blue")}>
              {renderInline(lt.tokens, ctx, k)}
            </Text>
            {showUrl ? <Text dimColor>{` (${lt.href})`}</Text> : null}
          </Text>
        );
      }
      case "image": {
        const it = t as Tokens.Image;
        return <Text key={k} dimColor>{`[image: ${it.text || it.href}]`}</Text>;
      }
      case "escape":
        return <Fragment key={k}>{(t as Tokens.Escape).text}</Fragment>;
      default:
        return <Fragment key={k}>{(t as { raw?: string }).raw ?? ""}</Fragment>;
    }
  });
}

/** Visible text of inline tokens, for measuring table column widths. */
function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let s = "";
  for (const t of tokens) {
    if ("tokens" in t && Array.isArray(t.tokens) && t.tokens.length) s += plainText(t.tokens);
    else if ("text" in t && typeof t.text === "string") s += t.text;
  }
  return s;
}
