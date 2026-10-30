interface EmptyStateProps {
  onSuggest: (text: string) => void;
}

/**
 * Suggestion prompts. Clicking one sends it as a real message — these are
 * honest shortcuts, not decoration.
 */
const SUGGESTIONS = [
  "Explain a React concept simply",
  "Help me name a function",
  "Draft a short project update",
];

/** Inviting first-run state shown when the conversation has no messages. */
export function EmptyState({ onSuggest }: EmptyStateProps) {
  return (
    <div className="flex min-h-[65vh] flex-col items-center justify-center gap-10 px-2 text-center">
      <div className="flex flex-col items-center gap-3">
        <span
          aria-hidden="true"
          className="mb-1 h-3 w-3 rounded-full bg-[var(--accent)]"
        />
        <h2 className="text-2xl font-medium tracking-tight text-[var(--ink)] sm:text-3xl">
          What can I help with?
        </h2>
        <p className="max-w-md text-[15px] leading-6 text-[var(--ink-muted)]">
          Ask anything below. Replies stream in as they are written, and you can
          stop mid-response.
        </p>
      </div>

      <div className="grid w-full max-w-md gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSuggest(suggestion)}
            className="min-h-11 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-4 py-3 text-left text-[13px] leading-5 text-[var(--ink-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--ink)] active:bg-[var(--surface)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
