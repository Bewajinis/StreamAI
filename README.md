# Streaming AI — Chat

A responsive AI chat application built with Next.js (App Router), TypeScript, Tailwind CSS, and the Vercel AI SDK.

> **Status: fully wired.** The UI streams replies through `POST /api/chat`,
> with working Stop, multi-turn history, and conversation switching. Under
> `next dev` the route answers from a **development mock** (labelled, no API
> cost); set `CHAT_MODE=anthropic` in `.env.local` to call real Claude.
> See "Current status" below for how each state is exercised.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server (http://localhost:3000) |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint (flat config, `eslint.config.mjs`) |
| `npm run typecheck` | TypeScript check with no emit (`tsc --noEmit`) |
| `npm test` | State-transition tests (Node test runner via `tsx`) |

## Environment

Copy the placeholder file and fill in your own key:

```bash
cp .env.example .env.local
```

`ANTHROPIC_API_KEY` is read **server-side only**, in the route handler. It is
never exposed to the browser — do not prefix it with `NEXT_PUBLIC_`. `.env.local`
is git-ignored; `.env.example` holds names only and is safe to commit.

### Chat mode (`CHAT_MODE`)

| Value | Engine |
| --- | --- |
| unset | **mock** under `next dev` (`NODE_ENV=development`); **anthropic** for production, tests, and an unset `NODE_ENV` |
| `mock` | Development mock everywhere, including production — logs a loud warning |
| `anthropic` | Real Claude everywhere; requires `ANTHROPIC_API_KEY` |

The switch is read server-side on every request (`resolveChatMode()` in
`src/lib/ai/config.ts`) and reported in the `x-chat-mode` response header.
Mock mode never reads, needs, or exposes a key. Optional pacing knobs:
`MOCK_INITIAL_DELAY_MS` (default 260) and `MOCK_TOKEN_DELAY_MS` (default 18).

## Structure

```
src/
├── app/
│   ├── layout.tsx                # Root layout, fonts, metadata
│   ├── page.tsx                  # Chat page shell
│   ├── globals.css               # Tailwind import + design tokens
│   └── api/chat/route.ts         # Streaming chat route (AI SDK + Anthropic)
├── components/
│   ├── chat/
│   │   ├── chat.tsx              # Root layout: sidebar, transcript, composer
│   │   ├── sidebar.tsx           # New Chat + history (drawer on mobile)
│   │   ├── empty-state.tsx       # Empty-conversation prompt
│   │   ├── message-list.tsx      # Ordered transcript
│   │   ├── message.tsx           # Single user / assistant turn
│   │   ├── markdown.tsx          # Streaming-tolerant Markdown renderer
│   │   ├── thinking-indicator.tsx
│   │   └── composer.tsx          # Rounded input with Send / Stop
│   └── ui/
│       ├── button.tsx
│       └── icons.tsx
├── hooks/
│   ├── use-chat-session.ts       # Conversation state machine (AI SDK useChat)
│   └── use-auto-scroll.ts       # Pinned auto-scroll + jump-to-latest state
└── lib/
    ├── types.ts                  # Shared chat + API types
    ├── utils.ts                  # cn() and small helpers
    └── ai/
        ├── config.ts             # Server-only: provider, model, prompt, limits, CHAT_MODE
        ├── history.ts            # Placeholder-removal history sanitizer
        └── mock.ts               # Server-only: development mock stream
tests/                            # Node test runner suites (npm test)
```

## Design tokens

Palette lives in `src/app/globals.css` under `:root`: warm off-white canvas
(`#F7F5F0`), dark charcoal ink (`#292722`), muted terracotta accent
(`--accent: #D97757`). The palette is deliberately light-only so it always
matches the intended design regardless of OS theme.

## Current status

The UI is connected to the server route through the AI SDK's `useChat`
(`src/hooks/use-chat-session.ts` → `DefaultChatTransport` → `POST /api/chat`).
Both reply engines emit the same UI message stream protocol, so the client,
the thinking indicator, Stop, auto-scroll and error handling do not change
between them — only the bytes in the stream differ.

| State | How to see it |
| --- | --- |
| Empty conversation | Load the page, or start a new chat |
| User message submitted | Send a message |
| Assistant thinking indicator | Visible between send and the first token (the mock holds its first token for `MOCK_INITIAL_DELAY_MS`) |
| Progressive response | Tokens append to the assistant bubble as they arrive |
| **Stop** keeps partial text | Press **Stop** mid-stream; the input re-enables immediately |
| Completed response | Let the stream finish |
| **Error state** | Set `CHAT_MODE=anthropic` with no key, stop the dev server mid-session, or point `ANTHROPIC_BASE_URL` at an unreachable address |
| Auto-scroll release | Scroll up during a stream — "Jump to latest" appears |
| Conversation history | Switch threads in the sidebar; prior turns are sent with the next request |
| Mock labelling | In mock mode: a "Development mock — not a real Claude response" badge on each reply, the same notice as the first line of the reply text, and `x-chat-mode: mock` on the response |

## Tests

```bash
npm test
```

Runs the Node test runner through `tsx` over `tests/`:

- `history.test.ts` — placeholder-removal transitions (a stop before the first
  token must not leave an empty assistant turn for the next request).
- `route.test.ts` — request validation and error states (415/413/400/503/499),
  including that responses never echo key material, plus the `CHAT_MODE` switch
  itself. `CHAT_MODE` is pinned to `anthropic` for this file, so no test
  reaches the model and the suite performs zero network I/O.
- `config.test.ts` — `server-only` configuration guards, log redaction, mode
  resolution (`resolveChatMode()`: development → mock, everything else →
  Anthropic, explicit `CHAT_MODE` always wins, junk values rejected) and mock
  pacing.
- `mock.test.ts` — the development mock: token-by-token streaming and its
  label, multi-turn history read back into the reply, cancellation (abort ends
  the stream at once, keeps the partial text, emits no error), recovery on the
  next request, the shared error contract, and that no key ever reaches the
  client.
- `markdown.test.tsx` — streaming-render guarantees (incomplete Markdown stays
  literal, HTML is escaped, unsafe links never render).

The server-side files run under `--conditions=react-server`, the same module
graph Next.js uses, so the `server-only` marker resolves correctly.

## Verifying the server route locally

You can exercise the route end to end without touching the UI.

### 1. Configure

```bash
cp .env.example .env.local
```

Mock mode is the default under `next dev` and needs no configuration at all.
To use the real Anthropic integration instead, set `ANTHROPIC_API_KEY=<your key>`
and `CHAT_MODE=anthropic` in `.env.local`. Do not paste the key into chat,
commit it, or prefix it with `NEXT_PUBLIC_`. Restart the dev server afterwards —
Next.js reads `.env.local` only at startup.

### 2. Mock check (default under `next dev`)

Expect **200**, `x-chat-mode: mock`, and a reply that opens with the
"Development mock" notice:

```bash
curl -i -N http://localhost:3000/api/chat \
  -H "content-type: application/json" \
  -d '{"messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"Say hello"}]}]}'
```

### 3. Unconfigured check (`CHAT_MODE=anthropic`, no key set)

Expect **503**:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/chat \
  -H "content-type: application/json" \
  -d '{"messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"hi"}]}]}'
```

### 4. Streaming check (`CHAT_MODE=anthropic`, funded key set)

Expect **200**, `content-type: text/event-stream`, `x-chat-mode: anthropic`,
and `data: {...}` frames:

```bash
curl -i -N http://localhost:3000/api/chat \
  -H "content-type: application/json" \
  -d '{"messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"Say hello"}]}]}'
```

### Status codes

| Code | Meaning |
| --- | --- |
| 200 | Streaming reply (UI message stream) |
| 400 | Malformed JSON, wrong message shape, or parts the SDK cannot convert |
| 405 | Method other than `POST` |
| 413 | Body over 512 KiB, over 100 messages, or one message over 32,000 chars |
| 415 | `Content-Type` is not JSON |
| 499 | Client disconnected (or pressed Stop) before the stream started |
| 502 | Defensive fallback: the stream could not be created |
| 503 | `ANTHROPIC_API_KEY` missing in Anthropic mode, or `CHAT_MODE` set to an unusable value — the key is never echoed back |

Once the response has started streaming, an upstream failure can no longer
change the HTTP status. The AI SDK delivers it as an error part inside the
stream, which `useChat` surfaces as its `error` state; the server logs a
redacted copy only.

### Ambient `ANTHROPIC_BASE_URL` caveat

`@ai-sdk/anthropic` honours `ANTHROPIC_BASE_URL`, and Next.js **never
overwrites a variable already present in `process.env`** — so a value exported
in your shell wins over `.env.local`. If your shell already exports a base URL
(for example a local proxy), requests are routed there instead of
`api.anthropic.com`, and with nothing listening on that address the stream
fails with `ECONNREFUSED`. This includes *persistent* variables, not just ones
exported for the current shell (on Windows: System Properties → Environment
Variables, or `setx ANTHROPIC_BASE_URL ""` to clear it). Clear it for the
session if you want the official endpoint:

```powershell
Remove-Item Env:ANTHROPIC_BASE_URL    # PowerShell
```

```bash
unset ANTHROPIC_BASE_URL              # bash
```
