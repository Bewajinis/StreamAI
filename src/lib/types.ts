/**
 * Shared domain types for the chat application.
 *
 * `ChatStatus` deliberately mirrors the Vercel AI SDK chat status vocabulary
 * (`ready | submitted | streaming | error`) so `useChat`'s status can be handed
 * to the UI unchanged.
 */

/** Roles that can appear in a conversation turn. */
export type ChatRole = "user" | "assistant";

/**
 * Lifecycle of the current request.
 *
 * Matches the AI SDK `useChat` status vocabulary (`ready | submitted |
 * streaming | error`) so the hook's status can be handed to the UI unchanged.
 */
export type ChatStatus = "ready" | "submitted" | "streaming" | "error";

/**
 * Per-message lifecycle for assistant turns.
 *
 * `stopped` is distinct from `complete`: a stopped reply keeps its partial text
 * but is not presented as a finished answer.
 */
export type MessageState = "streaming" | "complete" | "stopped" | "error";

/**
 * True while a request owns the turn: submission is locked and Stop is offered.
 *
 * Shared by the composer (what disables Send) and the session hook (what
 * drives `isBusy`), so the single rule that re-enables the input after a Stop
 * lives in one place — `stop()` settles the SDK back to `ready`, and this
 * function is what turns that into an enabled composer.
 */
export function isTurnInFlight(status: ChatStatus): boolean {
  return status === "submitted" || status === "streaming";
}

/** A single rendered conversation turn. */
export interface ChatMessage {
  /** Stable client-generated id, used as the React key and for DOM anchors. */
  id: string;
  role: ChatRole;
  /** Plain text content of the message. */
  content: string;
  /** Epoch ms when the message was created. */
  createdAt: number;
  /** Assistant messages only: how this turn ended. */
  state?: MessageState;
  /**
   * Assistant messages only: the reply came from development mock mode.
   *
   * Rendered as a visible badge so simulated output is never mistaken for a
   * real Claude answer; carried through thread snapshots with the message.
   */
  mock?: boolean;
}

/** One conversation in the sidebar history. */
export interface Conversation {
  id: string;
  /** Display label, derived from the first user message. */
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Standard error envelope returned by server routes. */
export interface ApiError {
  error: string;
  detail?: string;
}
