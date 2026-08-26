import assert from "node:assert/strict";
import test from "node:test";

import {
  renderAnswerContent,
  updateVerificationPresentation,
  VERIFIED_ANSWER_BADGE,
  VERIFIED_KNOWLEDGE_NOTE,
} from "../dist/answer-presentation.js";

test("renders verification and verified-knowledge indicators", () => {
  const content = renderAnswerContent("A useful answer.", {
    isVerified: true,
    usedVerifiedKnowledge: true,
  });

  assert.match(content, /A useful answer\./);
  assert.ok(content.includes(VERIFIED_ANSWER_BADGE));
  assert.ok(content.includes(VERIFIED_KNOWLEDGE_NOTE));
});

test("verification can be added and removed without losing the knowledge note", () => {
  const initial = renderAnswerContent("A useful answer.", {
    isVerified: false,
    usedVerifiedKnowledge: true,
  });
  const verified = updateVerificationPresentation(initial, true);
  const unverified = updateVerificationPresentation(verified, false);

  assert.ok(verified.includes(VERIFIED_ANSWER_BADGE));
  assert.ok(verified.includes(VERIFIED_KNOWLEDGE_NOTE));
  assert.ok(!unverified.includes(VERIFIED_ANSWER_BADGE));
  assert.ok(unverified.includes(VERIFIED_KNOWLEDGE_NOTE));
});

test("status indicators fit inside Discord's message limit", () => {
  const content = renderAnswerContent("x".repeat(2_500), {
    isVerified: true,
    usedVerifiedKnowledge: true,
  });

  assert.equal(content.length, 2_000);
  assert.ok(content.endsWith(VERIFIED_KNOWLEDGE_NOTE));
});
