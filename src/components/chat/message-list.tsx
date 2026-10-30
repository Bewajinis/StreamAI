import type { ChatMessage } from "@/lib/types";
import { Message } from "./message";

interface MessageListProps {
  messages: ChatMessage[];
}

/** Ordered transcript. `<ol>` because conversation turns are inherently ordered. */
export function MessageList({ messages }: MessageListProps) {
  return (
    <ol className="flex flex-col gap-7">
      {messages.map((message) => (
        <li key={message.id} className="flex w-full">
          <Message message={message} />
        </li>
      ))}
    </ol>
  );
}
