"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How close to the bottom (in px) still counts as "pinned". While pinned, new
 * content auto-scrolls; once the user scrolls further up than this, auto-scroll
 * stops so reading history is never yanked away.
 */
const PIN_THRESHOLD_PX = 96;

/**
 * Smart auto-scroll for a scrollable container.
 *
 * Scroll positioning is instant rather than smooth. That is intentional: smooth
 * scrolling fights the per-token updates of a stream, and instant scrolling is
 * automatically respectful of `prefers-reduced-motion`.
 *
 * `isAtBottom` flips when the user crosses the pin threshold in either
 * direction, so the UI can offer a "Jump to latest" control while the user is
 * reading history. React bails out of re-rendering when the value is unchanged,
 * so the per-frame scroll handler stays cheap during a stream.
 *
 * @param contentLength Any value that changes as the transcript grows.
 */
export function useAutoScroll(contentLength: number) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= PIN_THRESHOLD_PX;
    pinnedRef.current = atBottom;
    setIsAtBottom(atBottom);
  }, []);

  /** Re-engages auto-scroll; call before appending a message the user just sent. */
  const pin = useCallback(() => {
    pinnedRef.current = true;
    setIsAtBottom(true);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [contentLength, scrollToBottom]);

  return { containerRef, handleScroll, pin, scrollToBottom, isAtBottom };
}
