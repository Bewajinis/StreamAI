import { NextResponse } from "next/server";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import type { ApiError } from "@/lib/types";
import { sanitizeConversationHistory } from "@/lib/ai/history";
import { createMockChatResponse } from "@/lib/ai/mock";
import {
  CHAT_INSTRUCTIONS,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_OUTPUT_TOKENS,
  MAX_REQUEST_BYTES,
  AnthropicConfigurationError,
  ChatModeError,
  createChatModel,
  isAnthropicConfigured,
  redactSecrets,
  resolveChatMode,
  type ChatMode,
} from "@/lib/ai/config";

/**
 * Streaming chat route: accepts conversation history, replies from Anthropic
 * Claude (or from the development mock), and streams the result back.
 *
 * CHAT MODE
 * `resolveChatMode()` picks the reply engine: `mock` streams a simulated,
 * clearly-labelled answer from `@/lib/ai/mock` (the default under `next dev`,
 * needs no API key), `anthropic` calls Claude (the default everywhere else,
 * including production). The mode is chosen after request validation so both
 * engines share one validation and error contract; the active mode is reported
 * to the client in the `x-chat-mode` response header.
 *
 * STREAMING FORMAT
 * Both modes return the UI message stream protocol (`toUIMessageStreamResponse`
 * for Anthropic, `createUIMessageStreamResponse` for the mock), which is what
 * the AI SDK's `DefaultChatTransport` / `useChat` on the client parses. Any
 * other format (raw text, provider SSE) would not parse, so this choice is
 * dictated by the SDK version installed here (`ai@7.0.142`).
 *
 * SDK VERSION NOTES (verified against `node_modules/ai/dist/index.d.ts`, not
 * copied from docs for another major version):
 *  - `streamText({ system })` is `@deprecated`; the system prompt is passed as
 *    `instructions` instead.
 *  - `streamText({ messages })` takes `ModelMessage[]`, so UI messages are
 *    converted with `convertToModelMessages()`, which is async.
 *  - `UIMessage` carries `parts`, not `content`.
 *
 * ERROR CONTRACT (body is always the `ApiError` shape, never credentials)
 *  - 400 malformed body, invalid message shape, or messages the SDK cannot
 *    convert (e.g. unsupported part types).
 *  - 413 request body or individual message exceeds the configured limits.
 *  - 415 body present but not JSON.
 *  - 499 client disconnected before the stream started.
 *  - 503 `CHAT_MODE` set to an unusable value, or `ANTHROPIC_API_KEY` missing
 *    while in Anthropic mode — the key is never echoed back.
 *  - 502 request reached Anthropic but failed before any output streamed.
 *
 * Failures *after* streaming has begun cannot become an HTTP status; the AI
 * SDK ships them to the client as an error part in the stream, which `useChat`
 * surfaces as its `error` state. `onError` logs a redacted copy for debugging.
 *
 * RUNTIME: this project sets `cacheComponents: true`, and Next.js 16 rejects
 * the `runtime` route-segment config alongside it. Node.js is the default
 * runtime, which is what the Anthropic provider needs, so no export is
 * required here.
 */

function fail(status: number, error: string, detail?: string): Response {
  const body: ApiError = detail === undefined ? { error } : { error, detail };
  return NextResponse.json(body, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Outcome of validating a single message. `null` means the message is valid. */
type MessageProblem = { status: number; detail: string } | null;

/**
 * Structural validation of one inbound UI message.
 *
 * Only the contract `convertToModelMessages()` and the transport rely on is
 * checked — `role` and `parts`. Re-implementing the SDK's full
 * `UIMessagePart` union here would duplicate its types for no extra safety:
 * `convertToModelMessages()` still validates each part it converts and throws
 * on anything unexpected, which the route maps to a 400 below.
 */
function validateMessage(message: unknown, index: number): MessageProblem {
  const at = `Message ${index + 1}`;

  if (!isRecord(message)) {
    return { status: 400, detail: `${at} must be an object.` };
  }

  if (message.role !== "user" && message.role !== "assistant") {
    return {
      status: 400,
      detail:
        message.role === "system"
          ? `${at} uses the "system" role, which is not accepted: the system prompt is configured server-side.`
          : `${at} must have role "user" or "assistant".`,
    };
  }

  if (!Array.isArray(message.parts)) {
    return {
      status: 400,
      detail: `${at} must have a \`parts\` array (UI messages carry parts, not a content string).`,
    };
  }

  if (JSON.stringify(message).length > MAX_MESSAGE_CHARS) {
    return {
      status: 413,
      detail: `${at} exceeds the ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} character limit.`,
    };
  }

  for (const part of message.parts) {
    if (!isRecord(part) || typeof part.type !== "string") {
      return { status: 400, detail: `${at} contains a part without a string \`type\`.` };
    }
  }

  return null;
}

type Validation =
  | { ok: true; messages: UIMessage[] }
  | { ok: false; status: number; detail: string };

function validateBody(body: unknown): Validation {
  if (!isRecord(body)) {
    return { ok: false, status: 400, detail: "Expected a JSON object." };
  }

  const { messages } = body;

  if (!Array.isArray(messages)) {
    return { ok: false, status: 400, detail: "`messages` must be an array." };
  }

  if (messages.length === 0) {
    return { ok: false, status: 400, detail: "`messages` must not be empty." };
  }

  if (messages.length > MAX_MESSAGES) {
    return {
      ok: false,
      status: 413,
      detail: `\`messages\` may contain at most ${MAX_MESSAGES} messages (received ${messages.length}).`,
    };
  }

  for (let index = 0; index < messages.length; index += 1) {
    const problem = validateMessage(messages[index], index);
    if (problem !== null) {
      return { ok: false, status: problem.status, detail: problem.detail };
    }
  }

  // Every message satisfied the checks above; narrow the untrusted `unknown[]`
  // to the SDK type in one documented place rather than casting at each use.
  return { ok: true, messages: messages as UIMessage[] };
}

export async function POST(request: Request): Promise<Response> {
  // 1. Client already gone — do not spend tokens on a stream nobody reads.
  if (request.signal.aborted) {
    // 499: conventional "client closed request".
    return new Response(null, { status: 499 });
  }

  // 2. Content type: reject non-JSON up front, but tolerate a missing header.
  const contentType = request.headers.get("content-type");
  if (contentType !== null && !contentType.toLowerCase().includes("json")) {
    return fail(415, "Unsupported media type.", "Send the body as application/json.");
  }

  // 3. Payload size, checked on the raw bytes before parsing.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return fail(
      413,
      "Request body too large.",
      `Limit is ${MAX_REQUEST_BYTES / 1024} KiB.`,
    );
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return fail(400, "Could not read the request body.");
  }

  if (new TextEncoder().encode(raw).length > MAX_REQUEST_BYTES) {
    return fail(413, "Request body too large.", `Limit is ${MAX_REQUEST_BYTES / 1024} KiB.`);
  }

  // 4. Parse.
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "Invalid JSON body.");
  }

  // 5. Shape and limits.
  const validation = validateBody(body);
  if (!validation.ok) {
    return fail(validation.status, "Invalid request.", validation.detail);
  }

  // 5b. Drop assistant placeholders that never received a token (a stream
  //     stopped between `text-start` and the first delta leaves one behind).
  //     Defence in depth: the client transport already filters these, so this
  //     only protects against a stale client. Validation above runs first, so
  //     malformed history is still rejected with its specific reason.
  const conversation = sanitizeConversationHistory(validation.messages);
  if (conversation.length === 0) {
    return fail(400, "Invalid request.", "The conversation contains no content.");
  }

  // 6. Chat mode. Resolved after validation so a malformed payload fails the
  //    same way in both modes, and before any Anthropic work so mock mode
  //    needs neither a key nor a network. An unusable CHAT_MODE is a server
  //    misconfiguration, so it answers 503 with the fix — never a guess.
  let mode: ChatMode;
  try {
    mode = resolveChatMode();
  } catch (error) {
    if (error instanceof ChatModeError) {
      return fail(503, "The chat mode is configured incorrectly.", error.message);
    }
    throw error;
  }

  if (mode === "mock") {
    return createMockChatResponse({ messages: conversation, signal: request.signal });
  }

  // 7. Server configuration. Checked before any conversion work; the message
  //    explains how to fix it and never echoes the key itself.
  if (!isAnthropicConfigured()) {
    return fail(
      503,
      "The AI service is not configured.",
      "Set ANTHROPIC_API_KEY in .env.local (see .env.example) and restart the dev server.",
    );
  }

  let model;
  try {
    model = createChatModel();
  } catch (error) {
    if (error instanceof AnthropicConfigurationError) {
      return fail(503, "The AI service is not configured.", error.message);
    }
    throw error;
  }

  // 8. UI messages -> model messages. Throws on parts the SDK cannot convert;
  //    that is a client problem, so it maps to 400 rather than 502.
  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(conversation);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown conversion error";
    console.warn("[chat] rejected conversation: %s", redactSecrets(reason));
    return fail(
      400,
      "Invalid request.",
      "The conversation could not be converted for the model.",
    );
  }

  // 9. Stream the reply.
  //
  //    `abortSignal: request.signal` forwards the client's disconnect to
  //    Anthropic, so pressing Stop (or closing the tab) cancels the upstream
  //    request instead of letting it run to completion. An abort here is a
  //    normal, expected outcome and is deliberately not logged as an error.
  const result = streamText({
    model,
    instructions: CHAT_INSTRUCTIONS,
    messages: modelMessages,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: request.signal,
    onError: ({ error }) => {
      const reason =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error("[chat] stream failed: %s", redactSecrets(reason));
    },
  });

  try {
    // `x-chat-mode` mirrors the mock's header so the active engine is always
    // identifiable from a response, in either mode.
    return result.toUIMessageStreamResponse({
      headers: { "x-chat-mode": "anthropic" },
    });
  } catch (error) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error("[chat] failed to start stream: %s", redactSecrets(reason));
    return fail(502, "Upstream request failed.", "Anthropic did not accept the request.");
  }
}
