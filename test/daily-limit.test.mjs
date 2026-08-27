import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRemainingQuestions,
  limitReachedMessage,
} from "../dist/daily-limit.js";
import { memberHasModeratorRole } from "../dist/moderator-roles.js";

test("shows remaining daily questions only when a limit is enabled", () => {
  assert.match(
    formatRemainingQuestions({
      allowed: true,
      dailyLimit: 5,
      used: 3,
      remaining: 2,
    }),
    /2 questions/,
  );
  assert.equal(
    formatRemainingQuestions({ allowed: true, used: 0 }),
    undefined,
  );
  assert.match(limitReachedMessage(1), /daily limit of 1 AI question/);
});

test("moderator exemption requires any configured role", () => {
  const moderatorRoles = new Set(["mod-a", "mod-b"]);

  assert.equal(memberHasModeratorRole(["member", "mod-b"], moderatorRoles), true);
  assert.equal(memberHasModeratorRole(["member"], moderatorRoles), false);
});
