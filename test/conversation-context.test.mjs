import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveConversationContextLimits,
  selectConversationContext,
} from "../dist/conversation-context.js";

const messages = [
  {
    discordGuildId: "guild-a",
    discordUserId: "user-a",
    role: "user",
    content: "Tell me about helmet A.",
    createdAt: "2026-08-27T10:00:00.000Z",
  },
  {
    discordGuildId: "guild-a",
    discordUserId: "user-b",
    role: "user",
    content: "SECRET USER B CONTEXT",
    createdAt: "2026-08-27T10:01:00.000Z",
  },
  {
    discordGuildId: "guild-b",
    discordUserId: "user-a",
    role: "assistant",
    content: "SECRET OTHER GUILD CONTEXT",
    createdAt: "2026-08-27T10:02:00.000Z",
  },
  {
    discordGuildId: "guild-a",
    discordUserId: "user-a",
    role: "assistant",
    content: "Helmet A has the stored features.",
    createdAt: "2026-08-27T10:03:00.000Z",
  },
];

test("isolates conversation context by guild and Discord user", () => {
  const selected = selectConversationContext(messages, "guild-a", "user-a", {
    maxMessages: 10,
    tokenBudget: 1_000,
  });

  assert.deepEqual(
    selected.map((message) => message.content),
    ["Tell me about helmet A.", "Helmet A has the stored features."],
  );
  assert.ok(!JSON.stringify(selected).includes("SECRET"));
});

test("limits context by recent message count and token budget", () => {
  const selected = selectConversationContext(messages, "guild-a", "user-a", {
    maxMessages: 1,
    tokenBudget: 20,
  });

  assert.deepEqual(selected.map((message) => message.role), ["assistant"]);
});

test("validates configurable conversation limits", () => {
  assert.deepEqual(
    resolveConversationContextLimits({
      ORACLE_HISTORY_MAX_MESSAGES: "12",
      ORACLE_HISTORY_TOKEN_BUDGET: "2000",
    }),
    { maxMessages: 12, tokenBudget: 2_000 },
  );
  assert.throws(
    () =>
      resolveConversationContextLimits({
        ORACLE_HISTORY_MAX_MESSAGES: "unlimited",
      }),
    /ORACLE_HISTORY_MAX_MESSAGES/,
  );
});
