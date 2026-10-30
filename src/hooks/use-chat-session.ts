"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { APICallError, DefaultChatTransport, type UIMessage } from "ai";
import {
  isTurnInFlight,
  type ChatMessage,
  type Conversation,
  type MessageState,
} from "@/lib/types";
import { createMessageId } from "@/lib/utils";
import { sanitizeConversationHistory } from "@/lib/ai/history";

/**
 * Owns conversation history and the request lifecycle for the chat UI.
 *
 * TRANSPORT (AI SDK v7 / `@ai-sdk/react` v4 — verified against the installed
 * types, not examples from another major version):
 *  - `useChat` lives in `@ai-sdk/react`, not in `ai`. It is driven by
 *    `DefaultChatTransport`, which POSTs `{ id, messages, trigger, messageId }`
 *    to {@link CHAT_API} and parses the UI message stream the route returns.
 *  - `useChat().messages` is the source of truth for the *active* conversation:
 *    the user turn is pushed synchronously by `sendMessage`, the assistant turn
 *    appears when the stream starts, and every text delta replaces that
 *    message. History is therefore sent verbatim on the next turn, which is
 *    what keeps multi-turn context intact.
 *  - Inactive conversations are plain `Conversation` records. They are written
 *    when the user leaves a thread and read back through `setMessages`, so
 *    switching threads never re-fetches or loses anything.
 *  - `status` is already `ready | submitted | streaming | error`, i.e. exactly
 *    `ChatStatus`, so the UI state machine did not change.
 *
 * MOCK MODE: the route answers from a local mock when `CHAT_MODE` selects it
 * (development default). The transport, statuses, Stop path and error surface
 * are unchanged — only the bytes in the stream differ — and mock turns are
 * marked through message metadata so the UI can badge them.
 *
 * SECURITY: the browser only ever calls our own same-origin route. Anthropic
 * credentials stay server-side in `ANTHROPIC_API_KEY`.
 *
 * @see src/app/api/chat/route.ts
 * @see src/lib/ai/config.ts
 */

/** Same-origin endpoint; the browser never calls Anthropic directly. */
const CHAT_API = "/api/chat";

/* ------------------------------------------------------------------------ *
 * Conversation records (sidebar + inactive threads)
 * ------------------------------------------------------------------------ */

/**
 * Conversation created on first real activity.
 *
 * Stamps real timestamps and a generated id. Only ever called from event
 * handlers, never during render.
 */
function createConversation(): Conversation {
  const now = Date.now();
  return {
    id: createMessageId(),
    title: "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The conversation that exists before any user input.
 *
 * Free of `Date.now()` / random id generation on purpose: this runs inside a
 * `useState` initializer, so it executes during the prerender pass where
 * unstable values are rejected. Timestamps are stamped on first activity
 * instead, which is also the semantically honest choice for an empty thread.
 */
function createEmptyConversation(): Conversation {
  return {
    id: "conversation-initial",
    title: "New chat",
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function deriveTitle(firstMessage: string): string {
  const cleaned = firstMessage.trim().replace(/\s+/g, " ");
  if (cleaned.length <= 40) return cleaned || "New chat";
  return `${cleaned.slice(0, 39).trimEnd()}…`;
}

/* ------------------------------------------------------------------------ *
 * UIMessage <-> ChatMessage
 * ------------------------------------------------------------------------ */

/**
 * Plain text of a UI message.
 *
 * The UI renders text only, so non-text parts (files, tool calls) contribute
 * nothing here. This route has no tools and the composer sends text, so the
 * round trip is lossless for everything the app can produce.
 */
function textOf(message: UIMessage): string {
  let text = "";
  for (const part of message.parts) {
    if (part.type === "text") text += part.text;
  }
  return text;
}

/**
 * True when the server streamed this turn in development mock mode.
 *
 * The mock sets `{ mock: true }` metadata on its `start` chunk; nothing else
 * in the app can produce that marker, so a real Claude reply can never be
 * mistaken for one. Metadata is dropped by the SDK in some paths, which is why
 * the badge also survives in the message text (see `MOCK_REPLY_LEAD`) and is
 * re-attached when a stored thread is loaded back (see `toUIMessages`).
 */
function isMockMessage(message: UIMessage): boolean {
  const metadata: unknown = message.metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as { mock?: unknown }).mock === true
  );
}

/**
 * First-seen wall-clock time for a message id.
 *
 * `UIMessage` carries no timestamp, but `ChatMessage` requires one. Messages
 * only come into existence after a user action — never during the prerender
 * pass — so this client-side cache is never written per request and never
 * differs between the server and hydration render. Writes are idempotent per
 * id, which keeps them safe under StrictMode's double-invoked render.
 */
const messageCreatedAt = new Map<string, number>();

function createdAtOf(id: string): number {
  const existing = messageCreatedAt.get(id);
  if (existing !== undefined) return existing;
  const now = Date.now();
  messageCreatedAt.set(id, now);
  return now;
}

/**
 * Stored transcript -> the SDK message shape `setMessages` expects.
 *
 * Empty messages are dropped: an assistant placeholder that never received a
 * token carries no content, and sending it upstream could be rejected as an
 * empty turn.
 *
 * `mock` is carried through as message metadata so a thread loaded out of the
 * sidebar still badges its simulated turns; the server ignores metadata it
 * does not recognise on the way back up.
 */
function toUIMessages(messages: ChatMessage[]): UIMessage[] {
  return messages
    .filter((message) => message.content.length > 0)
    .map((message) => ({
      id: message.id,
      role: message.role,
      parts: [{ type: "text" as const, text: message.content }],
      ...(message.mock ? { metadata: { mock: true } } : {}),
    }));
}

/* ------------------------------------------------------------------------ *
 * Error presentation
 * ------------------------------------------------------------------------ */

function parseErrorBody(body: string | undefined): { error: string; detail?: string } | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.error === "string") {
        return {
          error: record.error,
          detail: typeof record.detail === "string" ? record.detail : undefined,
        };
      }
    }
  } catch {
    // Not JSON (an HTML error page, a proxy response, ...) — fall through.
  }
  return null;
}

/**
 * Turns the SDK's `Error` into something worth showing in the error banner.
 *
 * The transport throws `APICallError` with the raw response body as its
 * message, so a non-2xx from our route arrives here as
 * `{"error":"...","detail":"..."}`. That is parsed back into readable text;
 * anything unrecognised is trimmed so an HTML error page is never dumped into
 * the UI.
 */
function formatChatError(error: Error): string {
  const body = parseErrorBody(error.message);
  if (body) return body.detail ? `${body.error} ${body.detail}` : body.error;

  if (APICallError.isInstance(error)) {
    return typeof error.statusCode === "number"
      ? `The chat endpoint failed (HTTP ${error.statusCode}).`
      : "The chat endpoint failed unexpectedly.";
  }

  if (error.name === "TypeError" && /fetch|network|load failed/i.test(error.message)) {
    return "Could not reach the server. Check your connection and try again.";
  }

  return error.message.length > 300 ? `${error.message.slice(0, 297)}…` : error.message;
}

/* ------------------------------------------------------------------------ *
 * Hook
 * ------------------------------------------------------------------------ */

export function useChatSession() {
  // Instance-scoped and created once: the transport is stateless, but keeping
  // it out of module scope avoids sharing an object between server and client
  // render passes.
  //
  // `prepareSendMessagesRequest` re-emits the default body shape
  // (`{ id, messages, trigger, messageId }`) with the history sanitized first:
  // an assistant placeholder left behind by a stop-before-first-token is never
  // sent upstream. See `sanitizeConversationHistory` for why.
  const [transport] = useState(
    () =>
      new DefaultChatTransport({
        api: CHAT_API,
        prepareSendMessagesRequest: ({ id, messages, trigger, messageId, body }) => ({
          body: {
            ...body,
            id,
            messages: sanitizeConversationHistory(messages),
            trigger,
            messageId,
          },
        }),
      }),
  );

  const [conversations, setConversations] = useState<Conversation[]>(() => [
    createEmptyConversation(),
  ]);
  const [activeId, setActiveId] = useState<string | null>(null);

  /**
   * Assistant message ids the user explicitly stopped.
   *
   * `stop()` returns the hook to `ready`, which would otherwise make a partial
   * reply look finished. Ids are unique, so the set never needs clearing.
   */
  const [stoppedIds, setStoppedIds] = useState<ReadonlySet<string>>(() => new Set());

  /**
   * Synchronous in-flight latch for `send`, keyed by a token.
   *
   * `isBusy` is render state: two `send` calls in the same tick (rapid Enter
   * presses, a suggestion click racing a submit) would both observe
   * `isBusy === false`. The latch flips the moment the first call starts, so
   * the second is rejected before it can push a duplicate user message or
   * start a second request against the same thread. The token guards the
   * `finally`: an older request settling late can only clear the latch if it
   * still owns it, so it can never re-open the door underneath a newer one.
   */
  const activeSendRef = useRef<number | null>(null);
  const sendSeqRef = useRef(0);

  // Stable per mounted hook instance. Must be supplied: without an `id` the
  // SDK generates one with `Math.random()` *during render*, which Next.js
  // rejects while prerendering the page.
  const chatId = useId();

  const {
    messages: uiMessages,
    status,
    error,
    sendMessage,
    setMessages,
    stop: stopStream,
    clearError,
  } = useChat({ id: chatId, transport });

  const activeConversation =
    conversations.find((conversation) => conversation.id === activeId) ??
    conversations[0];

  const isBusy = isTurnInFlight(status);

  /**
   * Safety net for the in-flight latch.
   *
   * In the normal path `send`'s `finally` clears the latch before React ever
   * re-renders (the SDK settles its promises first). This effect guarantees
   * the latch also drops the moment the UI settles — the same render that
   * re-enables the composer — so a hung or externally-cancelled `sendMessage`
   * promise can never leave submission permanently disabled. It cannot clear
   * a newer request's latch: a new send sets `status` to `submitted`
   * synchronously, so a committed render can only ever show `ready`/`error`
   * while no request owns the latch.
   */
  useEffect(() => {
    if (status === "ready" || status === "error") {
      activeSendRef.current = null;
    }
  }, [status]);

  /**
   * Live SDK messages, projected onto the `ChatMessage` shape the UI renders.
   *
   * Per-message `state` is derived rather than stored, because only the *last*
   * assistant message can be in flight: everything before it finished (or was
   * finished by a stop that is still remembered in `stoppedIds`).
   */
  const messages = useMemo<ChatMessage[]>(() => {
    const lastIndex = uiMessages.length - 1;

    return uiMessages.map((uiMessage, index) => {
      const isAssistant = uiMessage.role === "assistant";
      const isLast = index === lastIndex;

      let state: MessageState | undefined;
      if (isAssistant) {
        state = !isLast
          ? "complete"
          : stoppedIds.has(uiMessage.id)
            ? "stopped"
            : status === "error"
              ? "error"
              : status === "ready"
                ? "complete"
                : "streaming";
      }

      return {
        id: uiMessage.id,
        role: isAssistant ? "assistant" : "user",
        content: textOf(uiMessage),
        createdAt: createdAtOf(uiMessage.id),
        state,
        // Mock flag rides along so the badge renders (and survives snapshots).
        ...(isAssistant && isMockMessage(uiMessage) ? { mock: true } : {}),
      };
    });
  }, [uiMessages, status, stoppedIds]);

  /**
   * Copies the active thread into its sidebar record.
   *
   * Called when the user leaves a thread (or starts a new one) — the SDK only
   * holds one conversation at a time, so this is where the others keep their
   * transcripts. Reading the derived `messages` here means the snapshot always
   * includes text that arrived in the current render.
   */
  const snapshotActiveConversation = useCallback(() => {
    const targetId = activeConversation?.id;
    if (!targetId || messages.length === 0) return;

    const snapshot = messages;
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === targetId
          ? { ...conversation, messages: snapshot, updatedAt: Date.now() }
          : conversation,
      ),
    );
  }, [activeConversation?.id, messages]);

  /**
   * Remembers that the in-flight assistant reply was interrupted.
   *
   * Called on every abort path (Stop, new chat, thread switch). The id lives
   * in `stoppedIds` for the session, so a partial reply still reads as
   * `stopped` after its thread is snapshotted and restored — `toUIMessages`
   * drops the derived state, but the id survives the round trip.
   */
  const markInFlightAssistantStopped = useCallback(() => {
    if (status !== "submitted" && status !== "streaming") return;
    const last = uiMessages[uiMessages.length - 1];
    if (last?.role === "assistant") {
      setStoppedIds((current) => new Set(current).add(last.id));
    }
  }, [status, uiMessages]);

  const send = useCallback(
    async (text: string): Promise<void> => {
      // Same-tick duplicate guard; see `activeSendRef`.
      if (activeSendRef.current !== null) return;

      const conversation = activeConversation;
      if (!conversation || isBusy) return;

      const trimmed = text.trim();
      if (trimmed.length === 0) return;

      // Title comes from the first turn of *this* thread, so it is measured
      // against the live messages rather than the stored record.
      if (uiMessages.length === 0) {
        const title = deriveTitle(trimmed);
        setConversations((current) =>
          current.map((item) =>
            item.id === conversation.id ? { ...item, title } : item,
          ),
        );
      }

      // Claim the latch before anything async so a second call in this same
      // tick is rejected.
      const token = ++sendSeqRef.current;
      activeSendRef.current = token;

      // User turn: `sendMessage({ text })` pushes it synchronously, so it
      // renders before the request is even on the wire; the SDK mints the
      // message id inside this handler (never during render). `messageId` is
      // deliberately NOT passed: in this SDK version it means "replace the
      // existing message with this id" and throws for an unknown id.
      //
      // Resolves when the turn ends; request failures are surfaced through
      // `status`/`error` rather than as a rejection, so there is nothing to
      // catch here. `finally` releases the latch on completion, cancellation
      // (stop), and failure alike — the composer re-enables exactly once the
      // request is truly over.
      try {
        await sendMessage({ text: trimmed });
      } finally {
        if (activeSendRef.current === token) {
          activeSendRef.current = null;
        }
      }
    },
    [activeConversation, isBusy, uiMessages.length, sendMessage],
  );

  /**
   * Aborts the in-flight generation and keeps whatever text already arrived.
   *
   * Cancellation path (verified against the installed `ai@7` source):
   * `stop()` → SDK aborts the transport's `AbortController` synchronously →
   * the fetch is cancelled → the route's `request.signal` fires → forwarded to
   * Anthropic as `abortSignal`. The SDK then refuses every queued write to the
   * aborted response, so partial text is preserved and can never be
   * overwritten by a late chunk; it resolves once the pipeline is idle and
   * `status` returns to `ready`.
   *
   * After that settle, a placeholder that never received a token (stopped
   * between `text-start` and the first delta) is removed: no empty reply
   * bubble stays behind, and the next turn's history starts clean. A partial
   * reply with text is always kept and marked `stopped`.
   */
  const stop = useCallback(async (): Promise<void> => {
    if (status !== "submitted" && status !== "streaming") return;

    markInFlightAssistantStopped();
    await stopStream();

    // The pipeline is idle now (`stop()` awaits it), so no queued write can
    // re-add content after this check.
    setMessages((current) => {
      const tail = current[current.length - 1];
      if (tail?.role !== "assistant" || textOf(tail).length > 0) return current;
      return current.slice(0, -1);
    });
  }, [status, markInFlightAssistantStopped, stopStream, setMessages]);

  const newConversation = useCallback(() => {
    markInFlightAssistantStopped();
    // Synchronous abort: the signal fires before this returns, so no late
    // chunk can write into the thread we are about to snapshot.
    void stopStream();
    snapshotActiveConversation();

    const conversation = createConversation();
    setConversations((current) => [conversation, ...current]);
    setActiveId(conversation.id);
    setMessages([]);
    clearError();
  }, [
    markInFlightAssistantStopped,
    stopStream,
    snapshotActiveConversation,
    setMessages,
    clearError,
  ]);

  const selectConversation = useCallback(
    (id: string) => {
      if (id === activeConversation?.id) return;

      // Aborts synchronously before the swap so no late chunk can write into
      // the thread we are about to display.
      markInFlightAssistantStopped();
      void stopStream();
      snapshotActiveConversation();

      const target = conversations.find((conversation) => conversation.id === id);
      setActiveId(id);
      setMessages(target ? toUIMessages(target.messages) : []);
      clearError();
    },
    [
      activeConversation?.id,
      conversations,
      markInFlightAssistantStopped,
      stopStream,
      snapshotActiveConversation,
      setMessages,
      clearError,
    ],
  );

  return {
    conversations,
    activeConversationId: activeConversation?.id ?? null,
    activeTitle: activeConversation?.title ?? "New chat",
    messages,
    status,
    error: error ? formatChatError(error) : null,
    isBusy,
    send,
    stop,
    newConversation,
    selectConversation,
    clearError,
  };
}
