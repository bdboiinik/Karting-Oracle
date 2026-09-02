import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKED_QUESTION_MESSAGE,
  evaluateQuestionAllowance,
  formatRemainingQuestions,
  formatUserQuestionLimitStatus,
  limitReachedMessage,
  shouldReserveDailyQuestion,
} from "../dist/daily-limit.js";
import { memberHasModeratorRole } from "../dist/moderator-roles.js";

test("shows remaining daily questions only when a limit is enabled", () => {
  assert.equal(
    formatRemainingQuestions({
      allowed: true,
      dailyLimit: 5,
      used: 3,
      remaining: 2,
    }),
    "⏳ Daily questions remaining: 2",
  );
  assert.equal(
    formatRemainingQuestions({
      allowed: true,
      dailyLimit: 5,
      used: 4,
      remaining: 0,
    }),
    "⏳ Daily questions remaining: 0",
  );
  assert.equal(
    formatRemainingQuestions({ allowed: true, used: 0 }),
    undefined,
  );
  assert.match(limitReachedMessage(1), /daily limit of 1 AI question/);
});

test("clarification replies do not reserve another daily question", () => {
  assert.equal(shouldReserveDailyQuestion(false, false), true);
  assert.equal(shouldReserveDailyQuestion(false, true), false);
  assert.equal(shouldReserveDailyQuestion(true, false), false);
});

test("moderator exemption requires any configured role", () => {
  const moderatorRoles = new Set(["mod-a", "mod-b"]);

  assert.equal(memberHasModeratorRole(["member", "mod-b"], moderatorRoles), true);
  assert.equal(memberHasModeratorRole(["member"], moderatorRoles), false);
});

test("a personal limit takes precedence over the server default", () => {
  assert.deepEqual(evaluateQuestionAllowance(20, 30, 8), {
    effectiveDailyLimit: 30,
    remaining: 22,
    isBlocked: false,
    allowed: true,
  });
  assert.deepEqual(evaluateQuestionAllowance(20, 5, 2), {
    effectiveDailyLimit: 5,
    remaining: 3,
    isBlocked: false,
    allowed: true,
  });
});

test("the server limit applies after a personal override is removed", () => {
  assert.deepEqual(evaluateQuestionAllowance(20, undefined, 8), {
    effectiveDailyLimit: 20,
    remaining: 12,
    isBlocked: false,
    allowed: true,
  });
});

test("changing or lowering a limit preserves today's usage", () => {
  assert.equal(evaluateQuestionAllowance(20, 30, 8).remaining, 22);
  assert.deepEqual(evaluateQuestionAllowance(20, 5, 8), {
    effectiveDailyLimit: 5,
    remaining: 0,
    isBlocked: false,
    allowed: false,
  });
});

test("a zero personal limit blocks questions without exposing admin details", () => {
  const allowance = evaluateQuestionAllowance(20, 0, 0);

  assert.equal(allowance.isBlocked, true);
  assert.equal(allowance.allowed, false);
  assert.match(BLOCKED_QUESTION_MESSAGE, /don't have access/);
  assert.doesNotMatch(BLOCKED_QUESTION_MESSAGE, /moderator|admin|limit/i);
});

test("status output includes server, override, usage, remaining, and blocking", () => {
  const output = formatUserQuestionLimitStatus("Test User", {
    serverDailyLimit: 20,
    personalDailyLimit: 5,
    effectiveDailyLimit: 5,
    used: 8,
    remaining: 0,
    isBlocked: false,
  });

  assert.match(output, /Server default: 20\/day/);
  assert.match(output, /Personal override: 5\/day/);
  assert.match(output, /Effective limit: 5\/day/);
  assert.match(output, /Used today: 8/);
  assert.match(output, /Remaining today: 0/);
  assert.match(output, /Blocked: No/);
});
