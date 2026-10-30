/**
 * Development mock streaming tests (mock mode of `POST /api/chat`).
 *
 * Covers the behaviours the mock exists to provide, all without a network call
 * and without an API key:
 *  - token-by-token delivery of one reply, with the development label;
 *  - multi-turn history: the reply reads every earlier turn;
 *  - cancellation: aborting the request stops the stream immediately, keeps
 *    the partial text, and emits no error;
 *  - recovery: a fresh request succeeds right after a stopped one;
 *  - the shared validation/error contract still applies in mock mode;
 *  - no credential ever reaches the client.
 *
 * Runs with `--conditions=react-server` (see the `test` script) so the
 * `server-only` marker in `src/lib/ai/mock.ts` resolves the same way it does
 * inside Next.js.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { POST } from "../src/app/api/chat/route";
import { MOCK_REPLY_LEAD, buildMockReply, tokenizeMockText } from "../src/lib/ai/mock";

const URL = "http://localhost/api/chat";
const FAKE_KEY = "sk-ant-test-fake-key-must-never-leak-1234567890";

const originalEnv = {
  CHAT_MODE: process.env.CHAT_MODE,
  MOCK_INITIAL_DELAY_MS: process.env.MOCK_INITIAL_DELAY_MS,
  MOCK_TOKEN_DELAY_MS: process.env.MOCK_TOKEN_DELAY_MS,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};

before(() => {
  // Mock mode, fast pacing: tests assert on chunk structure, not on wall time,
  // except for the cancellation test which sets its own deliberate slowness.
  process.env.CHAT_MODE = "mock";
  process.env.MOCK_INITIAL_DELAY_MS = "0";
  process.env.MOCK_TOKEN_DELAY_MS = "1";
  // The mock must work with no key at all — that is the point of the mode.
  delete process.env.ANTHROPIC_API_KEY;
});

after(() => {
  restore("CHAT_MODE", originalEnv.CHAT_MODE);
  restore("MOCK_INITIAL_DELAY_MS", originalEnv.MOCK_INITIAL_DELAY_MS);
  restore("MOCK_TOKEN_DELAY_MS", originalEnv.MOCK_TOKEN_DELAY_MS);
  restore("ANTHROPIC_API_KEY", originalEnv.ANTHROPIC_API_KEY);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

/** One UI message in the shape the route validates. */
function message(role: "user" | "assistant", text: string): UIMessage {
  return {
    id: `${role}-${text.length}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    parts: [{ type: "text", text }],
  } as UIMessage;
}

function makeRequest(messages: UIMessage[], signal?: AbortSignal): Request {
  return new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "test-thread", messages, trigger: "submit" }),
    ...(signal ? { signal } : {}),
  });
}

/** A single chunk of the AI SDK UI message stream protocol. */
interface StreamPart {
  type: string;
  id?: string;
  delta?: string;
  errorText?: string;
  finishReason?: string;
  messageMetadata?: { mock?: boolean; mode?: string };
}

function parseSse(text: string): StreamPart[] {
  const parts: StreamPart[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length);
    if (payload === "[DONE]") continue;
    parts.push(JSON.parse(payload) as StreamPart);
  }
  return parts;
}

/** Reads a whole response body and parses it into stream parts. */
async function readAll(response: Response): Promise<StreamPart[]> {
  return parseSse(await response.text());
}

/**
 * Yields stream parts as they arrive, one SSE frame at a time.
 *
 * Needed by the cancellation tests, which must interleave their own actions
 * with an in-progress stream rather than reading it to the end first.
 */
async function* streamParts(response: Response): AsyncGenerator<StreamPart> {
  const body = response.body;
  assert.ok(body, "streaming responses must have a body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /** Parses every complete frame, returning the incomplete tail untouched. */
  const drain = (input: string): { parts: StreamPart[]; rest: string } => {
    const parts: StreamPart[] = [];
    let rest = input;

    let separator = rest.indexOf("\n\n");
    while (separator !== -1) {
      const frame = rest.slice(0, separator);
      rest = rest.slice(separator + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ") && line.slice(6) !== "[DONE]") {
          parts.push(JSON.parse(line.slice(6)) as StreamPart);
        }
      }
      separator = rest.indexOf("\n\n");
    }
    return { parts, rest };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const drained = drain(buffer);
    buffer = drained.rest;
    for (const part of drained.parts) yield part;
  }

  const tail = drain(buffer + decoder.decode());
  for (const part of tail.parts) yield part;
}

function textOf(parts: StreamPart[]): string {
  return parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta ?? "")
    .join("");
}

/* ------------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------------ */

test("mock mode streams token-by-token and labels the reply as development output", async () => {
  const response = await POST(makeRequest([message("user", "Explain streaming briefly")]));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-chat-mode"), "mock");
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const parts = await readAll(response);

  // Protocol order: the message exists before any of its text does.
  assert.equal(parts[0]?.type, "start");
  assert.deepEqual(parts[0]?.messageMetadata, { mock: true, mode: "mock" });
  assert.equal(
    parts.findIndex((part) => part.type === "text-delta") >
      parts.findIndex((part) => part.type === "text-start"),
    true,
    "text-start must open the text part before deltas arrive",
  );

  const deltas = parts.filter((part) => part.type === "text-delta");
  assert.ok(deltas.length >= 3, `expected token-by-token deltas, got ${deltas.length}`);
  assert.ok(deltas.every((part) => (part.delta ?? "").length > 0), "no empty deltas");

  assert.equal(parts[parts.length - 1]?.type, "finish", "reply must finish cleanly");
  assert.equal(
    parts.some((part) => part.type === "error"),
    false,
    "a successful stream never carries an error part",
  );

  const text = textOf(parts);
  assert.ok(text.startsWith(MOCK_REPLY_LEAD), "every mock reply opens with the label");
  assert.ok(text.includes("Explain streaming briefly"), "the reply quotes the prompt");
  assert.ok(text.includes("mode | mock"), "the reply states that it is simulated");
});

test("tokens reassemble into the original text", () => {
  const sample =
    "A short sentence, with punctuation and gaps.\n\n```ts\nconst mode = \"mock\";\n```\n";
  const tokens = tokenizeMockText(sample);

  assert.ok(tokens.length > 8, `expected many tokens, got ${tokens.length}`);
  assert.equal(tokens.join(""), sample, "concatenating the deltas must be lossless");
  assert.ok(
    tokens.every((token) => token.length <= 14),
    "every delta must be token-sized",
  );
});

test("the mock reply quotes earlier turns (multi-turn history)", async () => {
  const conversation: UIMessage[] = [
    message("user", "My first question was about rivers"),
    message("assistant", "Rivers flow downhill and carve valleys."),
    message("user", "My second question was about deserts"),
  ];

  const response = await POST(makeRequest(conversation));
  assert.equal(response.status, 200);

  const parts = await readAll(response);
  const text = textOf(parts);

  assert.ok(text.includes("User turns received:** 2"), `turn count missing from: ${text}`);
  assert.ok(text.includes("My first question was about rivers"), "first user turn not quoted");
  assert.ok(text.includes("My second question was about deserts"), "latest user turn not quoted");
  assert.ok(
    text.includes("Rivers flow downhill"),
    "the previous assistant reply must be quoted too",
  );
  assert.equal(parts[parts.length - 1]?.type, "finish");
});

test("buildMockReply grows with the conversation instead of ignoring it", () => {
  const first = buildMockReply([message("user", "alpha")] as UIMessage[], 1);
  const later = buildMockReply(
    [
      message("user", "alpha"),
      message("assistant", "beta"),
      message("user", "gamma"),
      message("assistant", "delta"),
      message("user", "epsilon"),
    ] as UIMessage[],
    1,
  );

  assert.ok(first.includes("User turns received:** 1"));
  assert.ok(later.includes("User turns received:** 3"));
  assert.notEqual(first, later, "replies must depend on the history they were given");
});

/* ------------------------------------------------------------------------ *
 * Cancellation
 * ------------------------------------------------------------------------ */

test("aborting the request stops the mock stream at once and keeps the partial reply", async () => {
  // Deliberately slow: a full reply would take ~8s, so anything ending near
  // instantly proves the abort interrupted the producer rather than the reply
  // simply being short.
  process.env.MOCK_INITIAL_DELAY_MS = "0";
  process.env.MOCK_TOKEN_DELAY_MS = "40";

  try {
    const controller = new AbortController();
    const response = await POST(
      makeRequest([message("user", "Tell me a very long story")], controller.signal),
    );
    assert.equal(response.status, 200);

    const parts: StreamPart[] = [];
    let abortedAt: number | null = null;

    for await (const part of streamParts(response)) {
      parts.push(part);
      if (abortedAt === null && parts.filter((p) => p.type === "text-delta").length >= 3) {
        abortedAt = Date.now();
        controller.abort();
      }
    }

    assert.notEqual(abortedAt, null, "the stream must still be running when we stop it");
    const elapsed = Date.now() - (abortedAt as number);

    const partial = textOf(parts);
    assert.ok(partial.length > 0, "the partial reply must be kept");
    assert.equal(
      parts.some((part) => part.type === "error"),
      false,
      "cancellation is not an error",
    );
    assert.equal(
      parts.some((part) => part.type === "finish"),
      false,
      "a stopped reply must not be reported as finished",
    );
    assert.equal(parts[parts.length - 1]?.type, "abort", "the stream ends with an abort part");

    const fullLength = buildMockReply([message("user", "Tell me a very long story")], 40).length;
    assert.ok(
      partial.length < fullLength / 2,
      `expected a partial reply, got ${partial.length}/${fullLength} characters`,
    );
    assert.ok(elapsed < 2000, `stream should stop immediately, took ${elapsed}ms`);
  } finally {
    process.env.MOCK_TOKEN_DELAY_MS = "1";
  }
});

/* ------------------------------------------------------------------------ *
 * Recovery after a stop
 * ------------------------------------------------------------------------ */

test("the next request works normally right after a stopped stream", async () => {
  process.env.MOCK_INITIAL_DELAY_MS = "0";
  process.env.MOCK_TOKEN_DELAY_MS = "30";

  // 1. Start a stream and stop it before it can finish.
  const controller = new AbortController();
  const stopped = await POST(
    makeRequest([message("user", "first attempt that will be stopped")], controller.signal),
  );
  assert.equal(stopped.status, 200);

  const stoppedParts: StreamPart[] = [];
  for await (const part of streamParts(stopped)) {
    stoppedParts.push(part);
    if (part.type === "text-delta") controller.abort();
  }
  assert.ok(textOf(stoppedParts).length > 0, "the stopped turn kept its partial text");
  assert.equal(stoppedParts.some((part) => part.type === "error"), false);

  // 2. Recovery: the server is idle again and a brand-new turn streams fully.
  process.env.MOCK_TOKEN_DELAY_MS = "1";
  const next = await POST(makeRequest([message("user", "second attempt after stopping")]));
  assert.equal(next.status, 200);
  assert.equal(next.headers.get("x-chat-mode"), "mock");

  const nextParts = await readAll(next);
  assert.equal(nextParts[0]?.type, "start", "the recovered turn opens a fresh message");
  assert.equal(nextParts[nextParts.length - 1]?.type, "finish");
  assert.ok(textOf(nextParts).includes("second attempt after stopping"));
  assert.equal(nextParts.some((part) => part.type === "error"), false);
});

/* ------------------------------------------------------------------------ *
 * Error handling and credentials
 * ------------------------------------------------------------------------ */

test("mock mode keeps the shared validation contract for bad payloads", async () => {
  const malformed = await POST(
    new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }),
  );
  assert.equal(malformed.status, 400);
  assert.equal(
    ((await malformed.json()) as { error: string }).error,
    "Invalid JSON body.",
    "mock mode must not change the error envelope",
  );

  const empty = await POST(makeRequest([]));
  assert.equal(empty.status, 400);

  const noKey = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    const valid = await POST(makeRequest([message("user", "hello")]));
    assert.equal(valid.status, 200, "mock mode needs no API key");
    await valid.text();
  } finally {
    if (noKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = noKey;
  }
});

test("a configured key is never sent to the client in mock mode", async () => {
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  try {
    const response = await POST(makeRequest([message("user", "hello again")]));
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes(FAKE_KEY), false, "the key must never reach the client");
    // The label arrives as deltas, so it is checked on the reassembled text.
    assert.match(
      textOf(parseSse(body)),
      /Development mock/,
      "the reply is clearly labelled as simulated",
    );
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
