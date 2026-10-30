// Temporary smoke test for the client chat path (DefaultChatTransport + the
// same Chat state machine useChat wraps). Deleted after the run.
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

const api = "http://127.0.0.1:3000/api/chat";
const textOf = (m) =>
  (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
const snapshot = (chat) =>
  chat.messages.map((m) => ({ role: m.role, text: textOf(m).slice(0, 220) }));

const chat = new Chat({
  id: "smoke",
  transport: new DefaultChatTransport({ api }),
});

console.log("=== TURN 1 ===");
console.log("status before send:", chat.status);
const turn1 = chat.sendMessage({ text: "Say hello briefly" });
await new Promise((r) => setTimeout(r, 150));
console.log("status mid-flight:", chat.status);
await turn1;
console.log("status after:", chat.status);
console.log("messages:", JSON.stringify(snapshot(chat), null, 2));

console.log("=== TURN 2 (history preservation) ===");
await chat.sendMessage({ text: "What was my previous message?" });
console.log("status after:", chat.status);
console.log("messages:", JSON.stringify(snapshot(chat), null, 2));

console.log("=== TURN 3 (stop mid-stream) ===");
const turn3 = chat.sendMessage({ text: "Write a very long story about the sea" });
await new Promise((r) => setTimeout(r, 900));
console.log("status before stop:", chat.status, "| chars so far:", textOf(chat.lastMessage).length);
await chat.stop();
await turn3.catch(() => {});
console.log("status after stop:", chat.status);
console.log("last message kept partial text:", JSON.stringify(textOf(chat.lastMessage).slice(0, 120)));

console.log("=== TURN 4 (error state: stub server will be down) ===");
console.log("(run this script again after killing the stub to test errors)");
