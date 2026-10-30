/**
 * Conversation-history sanitisation shared by the client transport and the
 * chat route.
 *
 * WHY THIS EXISTS
 * When a stream is stopped before the first token, the AI SDK has already
 * created the assistant message shell: `text-start` pushes a text part with
 * `text: ""` and writes it into state (see `processUIMessageStream` in the
 * installed `ai` package). That placeholder is real state — the next turn
 * sends it verbatim as part of the history. An assistant turn whose only
 * content is empty text carries no information, and passing it upstream risks
 * a provider rejection of the whole (otherwise valid) conversation.
 *
 * The sanitizer drops exactly those turns, everywhere history crosses a
 * boundary:
 *  - the client transport (`prepareSendMessagesRequest` in
 *    `use-chat-session.ts`) keeps the request payload clean, and
 *  - the server route (`src/app/api/chat/route.ts`) protects against stale
 *    clients that still carry a placeholder.
 *
 * Dropping an assistant turn never breaks role alternation: the Anthropic
 * provider groups consecutive same-role messages into a single block before
 * sending (`groupIntoBlocks` in `@ai-sdk/anthropic`), so the user turns
 * around a removed placeholder are merged server-side.
 *
 * Pure, dependency-free, and safe to import from client and server code.
 */

import type { UIMessage } from "ai";

/**
 * True when a message contributes nothing to the model conversation.
 *
 * An assistant message qualifies only when *every* part is empty text. Any
 * non-text part (file, tool call, custom content) or any non-empty text keeps
 * the message — dropping those would lose real content.
 */
function isEmptyAssistant(message: UIMessage): boolean {
  if (message.role !== "assistant") return false;
  if (message.parts.length === 0) return true;
  return message.parts.every((part) => part.type === "text" && part.text.length === 0);
}

/**
 * Returns the history safe to send upstream: order preserved, empty assistant
 * placeholders removed, everything else untouched.
 */
export function sanitizeConversationHistory(messages: UIMessage[]): UIMessage[] {
  return messages.filter((message) => !isEmptyAssistant(message));
}
