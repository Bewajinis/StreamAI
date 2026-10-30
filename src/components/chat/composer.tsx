"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { isTurnInFlight, type ChatStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { SendIcon, StopIcon } from "@/components/ui/icons";

interface ComposerProps {
  status: ChatStatus;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Blocks submission entirely (e.g. while a view is read-only). */
  disabled?: boolean;
}

const MAX_ROWS = 8;

/** Caps the composer height before the textarea starts scrolling internally. */
const MAX_COMPOSER_HEIGHT_REM = `calc(${MAX_ROWS} * 1.5rem)`;

/**
 * Rounded message composer with distinct Send and Stop states.
 *
 * Enter sends, Shift+Enter inserts a newline, and Escape blurs the field. The
 * submit button swaps to a Stop control while a turn is in flight so the
 * interruption path is always one tap away.
 */
export function Composer({
  status,
  onSend,
  onStop,
  disabled = false,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Locked while a turn is in flight; `isTurnInFlight` flips back to false the
  // moment a Stop (or a failure) settles the SDK to `ready`, which is what
  // re-enables Send for the next message.
  const isBusy = isTurnInFlight(status);
  const canSend = value.trim().length > 0 && !isBusy && !disabled;

  // Auto-grow the textarea; CSS `max-height` clamps it and `overflow-y-auto`
  // takes over once the content exceeds that cap.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  function submit() {
    if (!canSend) return;
    const text = value.trim();
    setValue("");
    onSend(text);
    textareaRef.current?.focus();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
      return;
    }

    if (event.key === "Escape") {
      textareaRef.current?.blur();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Message composer"
      className="flex w-full items-end gap-2 rounded-2xl border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-2 shadow-[0_1px_2px_rgba(41,39,34,0.04)] transition-colors focus-within:border-[var(--accent)]"
    >
      <label htmlFor="composer-input" className="sr-only">
        Message
      </label>

      <textarea
        id="composer-input"
        ref={textareaRef}
        rows={1}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Send a message…"
        disabled={disabled}
        enterKeyHint="send"
        className={cn(
          "min-h-11 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-2.5 text-[15px] leading-6 text-[var(--ink)] outline-none",
          "placeholder:text-[var(--ink-subtle)]",
          "disabled:opacity-50",
        )}
        style={{ maxHeight: MAX_COMPOSER_HEIGHT_REM }}
      />

      {isBusy ? (
        <Button
          type="button"
          variant="danger"
          size="md"
          onClick={onStop}
          aria-label="Stop generating response"
          className="mb-0.5"
        >
          <StopIcon className="h-4 w-4" />
          Stop
        </Button>
      ) : (
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={!canSend}
          aria-label="Send message"
          className="mb-0.5"
        >
          <SendIcon className="h-4 w-4" />
          Send
        </Button>
      )}
    </form>
  );
}
