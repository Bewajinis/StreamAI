/**
 * Streaming-render tests for the Markdown renderer.
 *
 * The transcript renders partial buffers on every token, so these cases pin
 * the two guarantees the UI depends on: incomplete syntax never breaks the
 * layout (it stays literal until its closing delimiter arrives), and
 * model-authored text can never become active HTML or an unsafe link.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Markdown } from "../src/components/chat/markdown";

function render(content: string): string {
  return renderToStaticMarkup(createElement(Markdown, { content }));
}

test("incomplete bold stays literal until the closing delimiter streams in", () => {
  assert.ok(render("**bol").includes("**bol"));
  assert.ok(!render("**bol").includes("<strong>"));
  assert.ok(render("**bold**").includes("<strong>"));
});

test("incomplete italic stays literal", () => {
  assert.ok(render("*it").includes("*it"));
  assert.ok(!render("*it").includes("<em>"));
  assert.ok(render("*it*").includes("<em>"));
});

test("snake_case is never emphasised", () => {
  assert.ok(render("use snake_case_names here").includes("snake_case_names"));
});

test("an unclosed code fence renders as a code block (auto-closed)", () => {
  const html = render("```js\nconsole.log(1");
  assert.ok(html.includes("<pre"));
  assert.ok(html.includes("console.log(1"));
});

test("a closed fence renders without leaking backticks", () => {
  const html = render("```js\nconsole.log(1)\n```");
  assert.ok(html.includes("<pre"));
  assert.ok(!html.includes("```"));
});

test("an incomplete inline code span stays literal", () => {
  assert.ok(render("run `npm install").includes("`npm install"));
});

test("complete inline code renders and suppresses nested formatting", () => {
  const html = render("use `npm run dev` and `**not bold**`");
  assert.ok(html.includes("<code"));
  assert.ok(html.includes("npm run dev"));
  assert.ok(html.includes("**not bold**"));
  assert.ok(!html.includes("<strong>"));
});

test("headings, lists, quotes, and rules render as their elements", () => {
  assert.ok(render("## Title").includes("<h4"));
  assert.ok(render("- a\n- b").includes("<ul"));
  assert.ok(render("1. a\n2. b").includes("<ol"));
  assert.ok(render("> quoted").includes("<blockquote"));
  assert.ok(render("---").includes("<hr"));
});

test("soft line breaks inside a paragraph are preserved", () => {
  const html = render("line1\nline2");
  assert.ok(html.includes("line1"));
  assert.ok(html.includes("line2"));
  // The renderer keeps the newline in text and opts into CSS pre-wrap so the
  // browser shows it; the markup carries the utility class, not a style.
  assert.ok(html.includes("whitespace-pre-wrap"));
  assert.ok(html.includes("\n") || html.includes("&#10;"));
});

test("raw HTML is rendered as escaped text, never as markup", () => {
  const html = render('<img src=x onerror="alert(1)">');
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});

test("safe links render as anchors with rel protection", () => {
  const html = render("[Docs](https://example.com)");
  assert.ok(html.includes("<a "));
  assert.ok(html.includes("https://example.com"));
  assert.ok(html.includes("noopener"));
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

test("mailto links render; unsafe protocols stay literal", () => {
  assert.ok(render("[mail](mailto:a@b.c)").includes("<a "));
  const unsafe = render("[click](javascript:alert(1))");
  assert.ok(!unsafe.includes("<a "));
  assert.ok(!unsafe.includes("href"));
});

test("an incomplete link stays literal until fully streamed", () => {
  const html = render("[Docs](https://exa");
  assert.ok(!html.includes("<a "));
  assert.ok(html.includes("[Docs]"));
});

test("empty content renders nothing", () => {
  assert.equal(render(""), "");
});
