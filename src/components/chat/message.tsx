import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/lib/types";
import { ThinkingIndicator } from "./thinking-indicator";
import { Markdown } from "./markdown";

interface MessageProps {
  message: ChatMessage;
}

/**
 * A single conversation turn.
 *
 * User turns sit in a soft filled bubble as plain text (what they typed is
 * what they see); assistant turns render on the canvas through the streaming-
 * tolerant Markdown renderer. Distinct, but neither is visually louder than
 * the other.
 */
export function Message({ message }: MessageProps) {
  const isUser = message.role === "user";
  const isEmpty = message.content.length === 0;
  // Waiting for the first token: the reply slot exists but has no text yet.
  const isWaiting = isEmpty && message.state === "streaming";

  return (
    <article
      aria-label={isUser ? "Your message" : "Assistant reply"}
      className={cn("flex w-full flex-col gap-1", isUser && "items-end")}
    >
      <div
        className={cn(
          "max-w-[92%] text-[15px] leading-7 break-words sm:max-w-[85%]",
          isUser
            ? "whitespace-pre-wrap rounded-2xl rounded-br-md bg-[var(--surface)] px-4 py-2.5 text-[var(--ink)]"
            : "text-[var(--ink)]",
        )}
      >
        {/*
          The indicator renders in the reply's own slot rather than under the
          transcript, so the first token simply replaces it — no layout jump.
        */}
        {isWaiting ? (
          <ThinkingIndicator visible />
        ) : isUser ? (
          message.content
        ) : (
          <Markdown content={message.content} />
        )}
      </div>

      {/*
        Provenance label: development mock replies are simulated, and saying so
        in the transcript keeps them from ever reading as real Claude output.
        The same notice also opens the reply text itself, so it survives copy,
        paste, and a round trip through the sidebar snapshot.
      */}
      {message.mock ? (
        <span className="w-fit rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] font-medium tracking-wide text-[var(--ink-muted)]">
          Development mock — not a real Claude response
        </span>
      ) : null}

      {message.state === "stopped" ? (
        <p className="text-xs text-[var(--ink-subtle)]">
          Stopped — partial response kept.
        </p>
      ) : null}

      {message.state === "error" ? (
        <p role="alert" className="text-xs text-[var(--accent-hover)]">
          The response failed.
        </p>
      ) : null}
    </article>
  );
}
