/**
 * Server-side configuration safety tests.
 *
 * Runs with `--conditions=react-server` so the `server-only` marker resolves
 * to its empty build (the same graph Next.js uses for server code). Nothing
 * here constructs a network request: `createChatModel` only throws without a
 * key, and the key that is temporarily set is a fake value used solely to
 * prove it never leaks.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicConfigurationError,
  ChatModeError,
  createChatModel,
  isAnthropicConfigured,
  mockTiming,
  redactSecrets,
  resolveChatMode,
} from "../src/lib/ai/config";

const FAKE_KEY = "sk-ant-test-fake-key-must-never-leak-1234567890";
const originalKey = process.env.ANTHROPIC_API_KEY;

const originalEnv = {
  CHAT_MODE: process.env.CHAT_MODE,
  NODE_ENV: process.env.NODE_ENV,
  MOCK_INITIAL_DELAY_MS: process.env.MOCK_INITIAL_DELAY_MS,
  MOCK_TOKEN_DELAY_MS: process.env.MOCK_TOKEN_DELAY_MS,
};

/**
 * `NODE_ENV` is typed `readonly` by Next.js (a test can still legitimately
 * need to prove what a production build would do), so it goes through the
 * index signature here — and is restored by `after()` below.
 */
function setEnv(name: string, value: string | undefined): void {
  const env = process.env as unknown as Record<string, string | undefined>;
  if (value === undefined) delete env[name];
  else env[name] = value;
}

before(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

after(() => {
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
  for (const [name, value] of Object.entries(originalEnv)) setEnv(name, value);
});

test("isAnthropicConfigured is false when the key is unset", () => {
  assert.equal(isAnthropicConfigured(), false);
});

test("isAnthropicConfigured is false when the key is blank", () => {
  process.env.ANTHROPIC_API_KEY = "   ";
  assert.equal(isAnthropicConfigured(), false);
  delete process.env.ANTHROPIC_API_KEY;
});

test("isAnthropicConfigured is true when a key is present", () => {
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  assert.equal(isAnthropicConfigured(), true);
  delete process.env.ANTHROPIC_API_KEY;
});

test("createChatModel throws AnthropicConfigurationError without a key instead of at import time", () => {
  assert.throws(
    () => createChatModel(),
    (error: unknown) =>
      error instanceof AnthropicConfigurationError &&
      error.name === "AnthropicConfigurationError",
  );
});

test("createChatModel's error text names the env var but never contains key material", () => {
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  delete process.env.ANTHROPIC_API_KEY; // simulate the broken config: key removed after boot
  try {
    createChatModel();
    assert.fail("expected createChatModel to throw");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ANTHROPIC_API_KEY/);
    assert.ok(!error.message.includes(FAKE_KEY), "error must not echo a key");
  }
});

test("redactSecrets strips the key from log-bound text", () => {
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  const noisy = `request failed auth=${FAKE_KEY} endpoint=https://api.anthropic.com`;
  const clean = redactSecrets(noisy);
  assert.ok(!clean.includes(FAKE_KEY), "key must not survive redaction");
  assert.match(clean, /\[redacted\]/);
  assert.match(clean, /api\.anthropic\.com/, "non-secret context is preserved");
  delete process.env.ANTHROPIC_API_KEY;
});

test("redactSecrets is a no-op when no key is configured", () => {
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(redactSecrets("plain reason"), "plain reason");
});

test("redactSecrets does not mangle text when the key does not appear", () => {
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  assert.equal(redactSecrets("TypeError: fetch failed"), "TypeError: fetch failed");
  delete process.env.ANTHROPIC_API_KEY;
});

/* ------------------------------------------------------------------------ *
 * Chat mode: mock vs Anthropic
 * ------------------------------------------------------------------------ */

test("resolveChatMode defaults to mock in development", () => {
  setEnv("CHAT_MODE", undefined);
  setEnv("NODE_ENV", "development");
  assert.equal(resolveChatMode(), "mock");
});

test("resolveChatMode defaults to Anthropic in production — never a silent mock", () => {
  setEnv("CHAT_MODE", undefined);
  setEnv("NODE_ENV", "production");
  assert.equal(resolveChatMode(), "anthropic");
});

test("resolveChatMode defaults to Anthropic when NODE_ENV is the literal 'test'", () => {
  setEnv("CHAT_MODE", undefined);
  setEnv("NODE_ENV", "test");
  assert.equal(resolveChatMode(), "anthropic");
});

test("resolveChatMode defaults to Anthropic when NODE_ENV is not set at all", () => {
  setEnv("CHAT_MODE", undefined);
  setEnv("NODE_ENV", undefined);
  assert.equal(resolveChatMode(), "anthropic");
});

test("CHAT_MODE=anthropic opts development back into the real API", () => {
  setEnv("NODE_ENV", "development");
  setEnv("CHAT_MODE", "anthropic");
  assert.equal(resolveChatMode(), "anthropic");
});

test("CHAT_MODE=mock is honoured in production when set deliberately", () => {
  setEnv("NODE_ENV", "production");
  setEnv("CHAT_MODE", "mock");
  assert.equal(resolveChatMode(), "mock");
});

test("CHAT_MODE is trimmed and case-insensitive", () => {
  setEnv("NODE_ENV", "development");
  setEnv("CHAT_MODE", "  MoCk  ");
  assert.equal(resolveChatMode(), "mock");
});

test("a blank CHAT_MODE falls back to the environment default", () => {
  setEnv("NODE_ENV", "development");
  setEnv("CHAT_MODE", "   ");
  assert.equal(resolveChatMode(), "mock");
});

test("an unknown CHAT_MODE raises ChatModeError naming the variable", () => {
  setEnv("CHAT_MODE", "claude-3-opus");
  try {
    assert.throws(
      () => resolveChatMode(),
      (error: unknown) =>
        error instanceof ChatModeError &&
        error.name === "ChatModeError" &&
        /CHAT_MODE/.test(error.message),
    );
  } finally {
    setEnv("CHAT_MODE", undefined);
  }
});

/* ------------------------------------------------------------------------ *
 * Mock pacing
 * ------------------------------------------------------------------------ */

test("mockTiming honours explicit overrides", () => {
  setEnv("MOCK_INITIAL_DELAY_MS", "0");
  setEnv("MOCK_TOKEN_DELAY_MS", "5");
  assert.deepEqual(mockTiming(), { initialDelayMs: 0, tokenDelayMs: 5 });
});

test("mockTiming falls back to the defaults for junk or negative values", () => {
  setEnv("MOCK_INITIAL_DELAY_MS", "-3");
  setEnv("MOCK_TOKEN_DELAY_MS", "soon");
  assert.deepEqual(mockTiming(), { initialDelayMs: 260, tokenDelayMs: 18 });
});
