"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { isTurnInFlight } from "@/lib/types";
import { useChatSession } from "@/hooks/use-chat-session";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { Sidebar } from "./sidebar";
import { EmptyState } from "./empty-state";
import { MessageList } from "./message-list";
import { ThinkingIndicator } from "./thinking-indicator";
import { Composer } from "./composer";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon, MenuIcon } from "@/components/ui/icons";

/**
 * Root chat layout: restrained sidebar on desktop, slide-in drawer on mobile,
 * and a constrained conversation column with a rounded composer.
 *
 * Everything here is driven by `useChatSession`, which streams real replies
 * from `POST /api/chat`.
 */
export function Chat() {
  const session = useChatSession();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  /** Tracks whether the drawer was opened, so close restores focus exactly once. */
  const drawerWasOpenRef = useRef(false);

  const { messages, status, error, activeTitle } = session;
  const isError = status === "error" && error !== null;

  // Any growth in the transcript counts as a change worth scrolling for.
  const contentLength = useMemo(
    () =>
      messages.reduce(
        (total, message) => total + message.content.length + message.id.length,
        0,
      ),
    [messages],
  );

  const { containerRef, handleScroll, pin, scrollToBottom, isAtBottom } =
    useAutoScroll(contentLength);

  /**
   * Returns the viewport to the newest content and re-engages auto-scroll.
   *
   * Focus moves to the transcript container so a keyboard user is not dumped
   * back at the top of the document when the button unmounts beneath them.
   */
  function jumpToLatest() {
    pin();
    scrollToBottom();
    containerRef.current?.focus();
  }

  const lastMessage = messages[messages.length - 1];
  const isBusy = isTurnInFlight(status);
  /*
   * Thinking indicator, in whichever slot the reply will occupy:
   *  - No assistant message yet (request in flight) → after the transcript,
   *    where the reply is about to appear.
   *  - Assistant message exists but is still empty → `Message` renders it
   *    inline, so the two states never show at once and the first token has
   *    nothing to displace but the dots themselves.
   */
  const showTrailingThinking = isBusy && lastMessage?.role !== "assistant";

  // Focus management for the drawer: move focus in when it opens so keyboard
  // users land inside it, and hand focus back to the menu button when it
  // closes — otherwise the closed drawer's `visibility: hidden` silently drops
  // focus to <body> and the next Tab starts from the top of the document.
  // (`focus()` on the menu button is a no-op at lg widths where it is
  // `display: none`, which is the intended behaviour on desktop.)
  useEffect(() => {
    if (drawerOpen) {
      drawerWasOpenRef.current = true;
      drawerRef.current?.focus();
      return;
    }
    if (drawerWasOpenRef.current) {
      drawerWasOpenRef.current = false;
      menuButtonRef.current?.focus();
    }
  }, [drawerOpen]);

  // Escape closes the drawer; body scroll is locked while it is open.
  useEffect(() => {
    if (!drawerOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    const previousOverflow = document.body.style.overflow;

    window.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerOpen]);

  function handleSend(text: string) {
    pin();
    void session.send(text);
  }

  function closeDrawer() {
    setDrawerOpen(false);
  }

  return (
    <div className="flex h-dvh w-full touch-manipulation overflow-hidden bg-[var(--canvas)] text-[var(--ink)]">
      {/* Backdrop only exists while the mobile drawer is open. */}
      {drawerOpen ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close conversation menu"
          onClick={closeDrawer}
          className="fixed inset-0 z-30 bg-[rgba(41,39,34,0.4)] lg:hidden"
        />
      ) : null}

      <aside
        id="app-sidebar"
        ref={drawerRef}
        tabIndex={-1}
        aria-label="Conversations"
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-[17.5rem] max-w-[85vw] shrink-0 overflow-hidden",
          "border-r border-[var(--border)] bg-[var(--surface)] outline-none",
          /* `visibility` is part of the transition so the closed drawer leaves the
             tab order, while still animating out before it disappears. */
          "transition-[transform,visibility] duration-200 ease-out motion-reduce:transition-none",
          drawerOpen ? "translate-x-0 visible" : "-translate-x-full invisible",
          "lg:static lg:z-auto lg:w-[16rem] lg:translate-x-0 lg:visible lg:overflow-visible xl:w-[18rem]",
        )}
      >
        <Sidebar
          conversations={session.conversations}
          activeId={session.activeConversationId}
          onNewChat={() => {
            pin();
            session.newConversation();
            closeDrawer();
          }}
          onSelect={(id) => {
            pin();
            session.selectConversation(id);
            closeDrawer();
          }}
          onClose={closeDrawer}
        />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 sm:px-5">
          <Button
            ref={menuButtonRef}
            variant="ghost"
            size="none"
            className="lg:hidden"
            aria-label="Open conversation menu"
            aria-expanded={drawerOpen}
            aria-controls="app-sidebar"
            onClick={() => setDrawerOpen(true)}
          >
            <MenuIcon className="h-5 w-5" />
          </Button>

          <h1 className="min-w-0 flex-1 truncate text-sm font-medium tracking-tight text-[var(--ink)]">
            {activeTitle}
          </h1>
        </header>

        <div
          ref={containerRef}
          onScroll={handleScroll}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 focus:outline-none sm:px-6"
        >
          <div className="mx-auto w-full max-w-3xl py-7">
            {messages.length === 0 ? (
              <EmptyState onSuggest={handleSend} />
            ) : (
              <>
                <MessageList messages={messages} />
                {showTrailingThinking ? (
                  <div className="mt-6">
                    <ThinkingIndicator visible />
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>

        {isError ? (
          <div
            role="alert"
            className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)]"
          >
            <div className="mx-auto flex w-full max-w-3xl items-start gap-3 px-4 py-3 sm:px-6">
              <span
                aria-hidden="true"
                className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[var(--ink)]">
                  Something went wrong
                </p>
                <p className="mt-0.5 break-words text-[13px] leading-5 text-[var(--ink-muted)]">
                  {error}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={session.clearError}>
                Dismiss
              </Button>
            </div>
          </div>
        ) : null}

        {/*
          The composer sits directly on the canvas with no divider, so it reads
          as part of the conversation screen rather than a separate toolbar.
        */}
        <div className="relative shrink-0 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:px-6 sm:pt-3">
          {/*
            Floating control, shown only while the user is reading history.
            It sits over the bottom of the transcript; the button itself carries
            a solid surface so it stays legible against scrolling text.
          */}
          {!isAtBottom ? (
            <div className="pointer-events-none absolute inset-x-0 -top-12 flex justify-center px-4">
              <Button
                variant="secondary"
                size="sm"
                className="pointer-events-auto shadow-[0_4px_16px_rgba(41,39,34,0.12)]"
                onClick={jumpToLatest}
              >
                <ChevronDownIcon className="-ml-1 h-4 w-4" />
                Jump to latest
              </Button>
            </div>
          ) : null}

          <div className="mx-auto w-full max-w-3xl">
            <Composer
              status={status}
              onSend={handleSend}
              onStop={session.stop}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
