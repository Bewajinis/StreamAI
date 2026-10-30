/**
 * Small dependency-free class-name helper.
 *
 * Deliberately avoids adding `clsx`/`tailwind-merge` for now: the foundation
 * only needs conditional class joining, and keeping the dependency count low
 * was a project requirement. Revisit if class merging becomes complex.
 */
export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

/** Generate a short unique id for client-side messages. */
export function createMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
