"use client";

import { cn } from "@/lib/utils";
import type { Conversation } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { PlusIcon, CloseIcon } from "@/components/ui/icons";

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  /** Rendered only in the mobile drawer, so it can dismiss it. */
  onClose?: () => void;
  className?: string;
}

/**
 * Conversation history plus the New Chat action.
 *
 * Desktop: a fixed, restrained rail. Mobile: rendered inside the drawer, where
 * `onClose` lets a selection dismiss it.
 */
export function Sidebar({
  conversations,
  activeId,
  onNewChat,
  onSelect,
  onClose,
  className,
}: SidebarProps) {
  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <span className="flex items-center gap-2 px-1 text-sm font-medium text-[var(--ink)]">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-full bg-[var(--accent)]"
          />
          Streaming AI
        </span>

        {onClose ? (
          <Button
            variant="ghost"
            size="none"
            className="lg:hidden"
            aria-label="Close conversation menu"
            onClick={onClose}
          >
            <CloseIcon className="h-4.5 w-4.5" />
          </Button>
        ) : null}
      </div>

      <div className="px-3 pb-2">
        <Button
          variant="secondary"
          className="w-full justify-start"
          onClick={onNewChat}
        >
          <PlusIcon className="h-4 w-4" />
          New chat
        </Button>
      </div>

      <nav aria-label="Conversation history" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <p className="px-2 pb-2 pt-3 text-[11px] font-medium uppercase tracking-wider text-[var(--ink-subtle)]">
          History
        </p>

        {conversations.length === 0 ? (
          <p className="px-2 text-[13px] text-[var(--ink-subtle)]">
            No conversations yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {conversations.map((conversation) => {
              const isActive = conversation.id === activeId;

              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => onSelect(conversation.id)}
                    className={cn(
                      "flex min-h-10 w-full items-center truncate rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
                      isActive
                        ? "bg-[var(--surface-raised)] text-[var(--ink)]"
                        : "text-[var(--ink-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]",
                    )}
                    title={conversation.title}
                  >
                    {conversation.title}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </div>
  );
}
