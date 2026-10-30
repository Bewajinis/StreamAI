/**
 * State-transition tests for conversation-history sanitisation.
 *
 * The critical transition is "stop before the first token": the AI SDK leaves
 * an empty assistant placeholder in state, and this sanitizer is what keeps
 * that placeholder from reaching the model on the next turn — on the client
 * transport AND in the server route.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { sanitizeConversationHistory } from "../src/lib/ai/history";

function user(text: string): UIMessage {
  return { id: `u-${text}`, role: "user", parts: [{ type: "text", text }] };
}

function assistant(...parts: UIMessage["parts"]): UIMessage {
  return { id: `a-${Math.random().toString(36).slice(2)}`, role: "assistant", parts };
}

function textPart(text: string): UIMessage["parts"][number] {
  return { type: "text", text };
}

test("drops the empty assistant placeholder left by a stop before the first token", () => {
  const messages = [user("hello"), assistant(textPart(""))];
  const result = sanitizeConversationHistory(messages);
  assert.equal(result.length, 1);
  assert.equal(result[0].role, "user");
});

test("keeps an assistant message that has any non-empty text", () => {
  const messages = [user("hi"), assistant(textPart("partial reply"))];
  assert.equal(sanitizeConversationHistory(messages).length, 2);
});

test("keeps an assistant message whose only part is non-text", () => {
  const messages = [
    user("hi"),
    assistant({ type: "file", mediaType: "text/plain", url: "data:text/plain,x" } as UIMessage["parts"][number]),
  ];
  assert.equal(sanitizeConversationHistory(messages).length, 2);
});

test("keeps an assistant message with mixed empty and non-empty text parts", () => {
  const messages = [user("hi"), assistant(textPart(""), textPart("kept"))];
  assert.equal(sanitizeConversationHistory(messages).length, 2);
});

test("never filters user messages", () => {
  const messages = [user(""), user("real")];
  assert.equal(sanitizeConversationHistory(messages).length, 2);
});

test("preserves ordering and drops every placeholder", () => {
  const messages = [
    user("one"),
    assistant(textPart("reply one")),
    user("two"),
    assistant(textPart("")),
    user("three"),
    assistant(textPart("reply three")),
  ];
  const result = sanitizeConversationHistory(messages);
  assert.deepEqual(
    result.map((m) => m.role),
    ["user", "assistant", "user", "user", "assistant"],
  );
  assert.equal(result[1].id, messages[1].id);
});

test("empty assistant with zero parts is dropped", () => {
  const messages = [user("hi"), assistant()];
  assert.equal(sanitizeConversationHistory(messages).length, 1);
});

test("does not mutate the input array", () => {
  const messages = [user("a"), assistant(textPart(""))];
  const snapshot = [...messages];
  sanitizeConversationHistory(messages);
  assert.deepEqual(messages, snapshot);
});
