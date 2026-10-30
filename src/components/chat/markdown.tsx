import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Dependency-free Markdown renderer tuned for streamed assistant replies.
 *
 * Two properties matter here and drive every design choice:
 *
 * 1. **Streaming safety.** Text arrives token by token, so half-finished
 *    syntax is the normal case, not an error. The parser only ever treats a
 *    construct as formatting when its closing delimiter is *already present*
 *    in the buffer; anything incomplete is emitted as literal text and
 *    re-interpreted on a later delta once it completes. An unclosed code
 *    fence is the one exception: it renders as a (closed) code block, which
 *    keeps partial code readable and avoids a paragraph-to-code layout jump
 *    when the fence finally closes.
 *
 * 2. **No HTML injection.** Output is React elements only — there is no
 *    `dangerouslySetInnerHTML` anywhere in this file, so model-authored text
 *    can never introduce markup, scripts, or `javascript:` URLs into the page.
 *
 * Supported constructs: ATX headings, fenced code blocks, ordered/unordered
 * lists, blockquotes, horizontal rules, paragraphs, inline code, bold,
 * italic, bold-italic, and `http(s)`/`mailto` links (rendered with
 * `target="_blank" rel="noopener noreferrer"`; every other protocol stays
 * literal text so untrusted URLs never become active targets). Images are
 * deliberately *not* resolved.
 */

/* ------------------------------------------------------------------------ *
 * Block model
 * ------------------------------------------------------------------------ */

type Block =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: number; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "quote"; lines: string[] }
  | { type: "hr" }
  | { type: "p"; text: string };

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING_RE = /^#{1,6}\s+(.*)$/;
const UL_RE = /^[-*+]\s+(.*)$/;
const OL_RE = /^\d{1,9}[.)]\s+(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const BLANK_RE = /^\s*$/;

/**
 * Splits source text into block-level constructs.
 *
 * Tolerant of truncated input: an unterminated fence is closed at end of
 * input, and a trailing partial line is treated as an ordinary paragraph line.
 */
function parseBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let i = 0;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "p", text: paragraph.join("\n") });
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (BLANK_RE.test(line)) {
      flushParagraph();
      i += 1;
      continue;
    }

    // Fenced code. An unclosed fence at end of input is auto-closed.
    const fence = line.match(FENCE_RE);
    if (fence) {
      flushParagraph();
      const marker = fence[2];
      const lang = fence[3] ?? "";
      const closeRe = new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`);
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !closeRe.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume the closing fence
      blocks.push({ type: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      flushParagraph();
      const hashes = line.match(/^#{1,6}/)?.[0].length ?? 1;
      blocks.push({ type: "heading", level: hashes, text: heading[1] });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      flushParagraph();
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    const quote = line.match(QUOTE_RE);
    if (quote) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length) {
        const next = lines[i].match(QUOTE_RE);
        if (!next) break;
        quoted.push(next[1]);
        i += 1;
      }
      blocks.push({ type: "quote", lines: quoted });
      continue;
    }

    const ul = line.match(UL_RE);
    if (ul) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length) {
        const next = lines[i].match(UL_RE);
        if (!next) break;
        items.push(next[1]);
        i += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    const ol = line.match(OL_RE);
    if (ol) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length) {
        const next = lines[i].match(OL_RE);
        if (!next) break;
        items.push(next[1]);
        i += 1;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return blocks;
}

/* ------------------------------------------------------------------------ *
 * Inline parsing
 * ------------------------------------------------------------------------ */

const isWordChar = (ch: string | undefined) =>
  ch !== undefined && /[A-Za-z0-9]/.test(ch);

/**
 * Only `http(s)` and `mailto` links are rendered as anchors. Anything else —
 * `javascript:`, `data:`, protocol-relative, or a bare incomplete URL — stays
 * literal text, so a model-authored link can never execute script or navigate
 * the page unexpectedly.
 */
function isSafeUrl(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href);
}

/**
 * Finds the next occurrence of `delim` that is not part of a longer run of the
 * same character, so a single `*` opener never pairs with a star inside `**`.
 */
function findInlineCloser(text: string, from: number, delim: string): number {
  const ch = delim[0];
  let idx = from;
  for (;;) {
    const found = text.indexOf(delim, idx);
    if (found === -1) return -1;
    if (found > 0 && text[found - 1] === ch) {
      idx = found + 1;
      continue;
    }
    const after = found + delim.length;
    if (after < text.length && text[after] === ch) {
      idx = found + 1;
      continue;
    }
    return found;
  }
}

/**
 * Underscore emphasis must sit on word boundaries (`_hi_` yes, `snake_case`
 * no); `*` has no such restriction.
 */
function underscoreBoundaryOk(text: string, open: number, closeEnd: number): boolean {
  return !isWordChar(text[open - 1]) && !isWordChar(text[closeEnd]);
}

/**
 * Parses inline constructs into React nodes.
 *
 * Incomplete pairs fall through as literal characters — `**bol` stays `**bol`
 * until the closing `**` streams in, rather than half-rendering as bold or
 * swallowing the rest of the line.
 */
function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let plain = "";
  let cursor = 0;
  let seq = 0;

  const flush = () => {
    if (plain !== "") {
      nodes.push(plain);
      plain = "";
    }
  };
  const key = () => `${keyPrefix}.${seq++}`;

  while (cursor < text.length) {
    // Inline code: a run of N backticks closes on the next run of exactly N.
    if (text[cursor] === "`") {
      let run = 0;
      while (text[cursor + run] === "`") run += 1;
      const marker = "`".repeat(run);
      const close = text.indexOf(marker, cursor + run);
      if (close !== -1) {
        flush();
        nodes.push(
          <code
            key={key()}
            className="rounded bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[0.875em] text-[var(--ink)]"
          >
            {text.slice(cursor + run, close)}
          </code>,
        );
        cursor = close + run;
        continue;
      }
      plain += marker;
      cursor += run;
      continue;
    }

    // Link: [label](href). Rendered only when the full syntax has streamed in
    // and the protocol is on the safe list; otherwise the `[` stays literal.
    if (text[cursor] === "[") {
      const closeBracket = text.indexOf("]", cursor + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const label = text.slice(cursor + 1, closeBracket);
          const href = text.slice(closeBracket + 2, closeParen).trim();
          if (isSafeUrl(href)) {
            flush();
            nodes.push(
              <a
                key={key()}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--accent-hover)] underline decoration-[var(--accent)] underline-offset-2 hover:text-[var(--accent)]"
              >
                {parseInline(label, key())}
              </a>,
            );
            cursor = closeParen + 1;
            continue;
          }
        }
      }
      plain += "[";
      cursor += 1;
      continue;
    }

    // Bold-italic: ***...*** or ___...___
    if (text.startsWith("***", cursor) || text.startsWith("___", cursor)) {
      const delim = text.slice(cursor, cursor + 3);
      const close = findInlineCloser(text, cursor + 3, delim);
      if (close !== -1 && (delim === "***" || underscoreBoundaryOk(text, cursor, close + 3))) {
        flush();
        nodes.push(
          <strong key={key()}>
            <em>{parseInline(text.slice(cursor + 3, close), key())}</em>
          </strong>,
        );
        cursor = close + 3;
        continue;
      }
      plain += delim;
      cursor += 3;
      continue;
    }

    // Bold: **...** or __...__
    if (text.startsWith("**", cursor) || text.startsWith("__", cursor)) {
      const delim = text.slice(cursor, cursor + 2);
      const close = findInlineCloser(text, cursor + 2, delim);
      if (close !== -1 && (delim === "**" || underscoreBoundaryOk(text, cursor, close + 2))) {
        flush();
        nodes.push(
          <strong key={key()}>{parseInline(text.slice(cursor + 2, close), key())}</strong>,
        );
        cursor = close + 2;
        continue;
      }
      plain += delim;
      cursor += 2;
      continue;
    }

    // Italic: *...* or _..._
    if (text[cursor] === "*" || text[cursor] === "_") {
      const delim = text[cursor];
      const close = findInlineCloser(text, cursor + 1, delim);
      if (
        close !== -1 &&
        close > cursor + 1 &&
        (delim === "*" || underscoreBoundaryOk(text, cursor, close + 1))
      ) {
        flush();
        nodes.push(<em key={key()}>{parseInline(text.slice(cursor + 1, close), key())}</em>);
        cursor = close + 1;
        continue;
      }
      plain += delim;
      cursor += 1;
      continue;
    }

    plain += text[cursor];
    cursor += 1;
  }

  flush();
  return nodes;
}

/* ------------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------------ */

const HEADING_CLASSES: Record<number, string> = {
  1: "mt-6 text-xl font-semibold first:mt-0",
  2: "mt-5 text-lg font-semibold first:mt-0",
  3: "mt-4 text-base font-semibold first:mt-0",
  4: "mt-4 text-[15px] font-semibold first:mt-0",
  5: "mt-3 text-sm font-semibold first:mt-0",
  6: "mt-3 text-sm font-medium first:mt-0",
};

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.type) {
    case "code":
      return (
        <pre
          key={index}
          className="my-3 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 font-mono text-[13px] leading-6 text-[var(--ink)]"
        >
          <code>{block.code}</code>
        </pre>
      );

    case "heading": {
      const Tag = (`h${Math.min(block.level + 2, 6)}`) as "h3" | "h4" | "h5" | "h6";
      return (
        <Tag key={index} className={cn(HEADING_CLASSES[block.level], "text-[var(--ink)]")}>
          {parseInline(block.text, `h${index}`)}
        </Tag>
      );
    }

    case "ul":
      return (
        <ul key={index} className="my-3 flex list-disc flex-col gap-1 pl-6 marker:text-[var(--ink-subtle)]">
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex} className="pl-1">
              {parseInline(item, `ul${index}.${itemIndex}`)}
            </li>
          ))}
        </ul>
      );

    case "ol":
      return (
        <ol key={index} className="my-3 flex list-decimal flex-col gap-1 pl-6 marker:text-[var(--ink-subtle)]">
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex} className="pl-1">
              {parseInline(item, `ol${index}.${itemIndex}`)}
            </li>
          ))}
        </ol>
      );

    case "quote":
      return (
        <blockquote
          key={index}
          className="my-3 border-l-2 border-[var(--border-strong)] pl-4 text-[var(--ink-muted)]"
        >
          {parseInline(block.lines.join("\n"), `q${index}`)}
        </blockquote>
      );

    case "hr":
      return <hr key={index} className="my-5 border-0 border-t border-[var(--border)]" />;

    case "p":
      return (
        <p key={index} className="my-3 whitespace-pre-wrap break-words first:mt-0 last:mb-0">
          {parseInline(block.text, `p${index}`)}
        </p>
      );
  }
}

interface MarkdownProps {
  content: string;
}

/**
 * Renders assistant reply text as Markdown.
 *
 * Single newlines inside a paragraph are preserved (`whitespace-pre-wrap`)
 * because assistant prose routinely uses them for line separation rather than
 * blank-line paragraphs; collapsing them would reflow the model's intended
 * structure mid-stream.
 */
export function Markdown({ content }: MarkdownProps) {
  if (content.length === 0) return null;
  return <>{parseBlocks(content).map(renderBlock)}</>;
}
