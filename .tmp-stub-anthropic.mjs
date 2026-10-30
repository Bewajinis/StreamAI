// Stub Anthropic Messages API for local reliability testing.
// Mimics POST /v1/messages with SSE streaming; records every request and
// whether the caller (the Next.js route) disconnected before the stream
// finished. Control plane: GET /__log, POST /__reset.
import http from "node:http";

const PORT = 1337;
const log = [];

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Plain text of a message in either UI (`parts`) or Anthropic (`content`) shape. */
function textOf(m) {
  if (Array.isArray(m.content)) {
    return m.content
      .map((c) => (typeof c === "string" ? c : c?.type === "text" ? c.text ?? "" : ""))
      .join("");
  }
  return (m.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** Build the outgoing reply from what the client sent (history-aware). */
function decideReply(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const users = messages.filter((m) => m.role === "user").map(textOf);
  const assistants = messages.filter((m) => m.role === "assistant").map(textOf);

  const lastUser = users[users.length - 1] ?? "";

  if (/first message/i.test(lastUser) || /earlier conversation/i.test(lastUser)) {
    // History probe: echo what we actually received.
    return (
      `History check. I received ${users.length} user turns and ${assistants.length} assistant turns. ` +
      `Your very first message was: "${users[0] ?? "(none)"}". ` +
      `Your previous partial reply was: "${(assistants[assistants.length - 1] ?? "").slice(0, 80)}".`
    );
  }
  if (/^reply with exactly the word PONG/i.test(lastUser.trim())) {
    return "PONG";
  }
  // Default: a long answer so the test has room to stop halfway.
  const words = [];
  for (let i = 1; i <= 220; i++) {
    words.push(`wave${i}`);
  }
  return `A very long story about the ocean. ${words.join(" ")}`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/__log") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(log, null, 2));
    return;
  }
  if (req.method === "POST" && req.url === "/__reset") {
    log.length = 0;
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "not_found_error", message: `stub: no route for ${req.method} ${req.url}` } }));
    return;
  }

  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "stub: bad json" } }));
    return;
  }

  const entry = {
    at: Date.now(),
    model: body.model,
    roles: (body.messages ?? []).map((m) => m.role),
    userTexts: (body.messages ?? []).filter((m) => m.role === "user").map(textOf),
    assistantTexts: (body.messages ?? []).filter((m) => m.role === "assistant").map(textOf),
    outcome: "pending", // pending -> completed | aborted
  };
  // A non-empty assistant text that came through as "" means an empty turn
  // escaped sanitisation — recorded so tests can assert it never happens.
  entry.hasEmptyAssistantTurn = entry.assistantTexts.some((t) => t.trim().length === 0);
  log.push(entry);

  const reply = decideReply(body);
  // Short replies stream character-by-character so growth is observable.
  const tokens = reply.length <= 12 ? reply.split("") : reply.split(/(?<=\s)/);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  let clientGone = false;
  res.on("close", () => {
    if (entry.outcome === "pending") {
      clientGone = true;
      entry.outcome = "aborted";
      entry.abortedAt = Date.now();
    }
  });

  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: "msg_stub_1",
      type: "message",
      role: "assistant",
      model: body.model ?? "claude-sonnet-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    },
  });
  sse(res, "ping", { type: "ping" });
  sse(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  const isShort = tokens.length <= 8;
  for (const token of tokens) {
    if (clientGone || res.destroyed || res.writableEnded) break;
    sse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: token },
    });
    await sleep(isShort ? 60 : 25);
  }

  if (clientGone || res.destroyed) return; // stop() landed; do not finish

  sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: tokens.length },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
  if (entry.outcome === "pending") entry.outcome = "completed";
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[stub] listening on http://127.0.0.1:${PORT}`);
});
