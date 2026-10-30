interface ThinkingIndicatorProps {
  /** Controlled by the parent, which knows both status and reply content. */
  visible: boolean;
}

/**
 * Three pulsing dots plus a label, shown before the first token arrives.
 *
 * The dots live in an `<ol>` so no UA list styling can leak in, and the region
 * is `aria-live="polite"` — announced once on appearance rather than per frame.
 * Animation is suppressed automatically under `prefers-reduced-motion`.
 */
export function ThinkingIndicator({ visible }: ThinkingIndicatorProps) {
  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2.5 text-[15px] text-[var(--ink-muted)]"
    >
      <ol aria-hidden="true" className="flex list-none items-center gap-1">
        <li className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:0ms]" />
        <li className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:160ms]" />
        <li className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:320ms]" />
      </ol>
      <span>Thinking…</span>
    </div>
  );
}
