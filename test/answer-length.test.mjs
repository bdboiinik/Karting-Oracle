import assert from "node:assert/strict";
import test from "node:test";

import {
  condenseAnswerForDiscord,
  MAX_ORACLE_ANSWER_CHARACTERS,
} from "../dist/answer-length.js";
import { ORACLE_BASE_INSTRUCTIONS } from "../dist/oracle-response.js";

test("keeps a concise simple answer intact", () => {
  const answer =
    "Generally, yes. In the wet the rubbered-in dry line can become slippery, so a wider line often gives more grip. Brake earlier and smoothly, turn gently, and look for clean tarmac. Do not go wide if it sends you through standing water or onto a worse surface.";

  assert.equal(condenseAnswerForDiscord(answer), answer);
  assert.ok(answer.length < 700);
});

test("keeps a complete normal answer within its intended range", () => {
  const sentence =
    "Use smooth steering and throttle inputs, then compare lap time and consistency before changing one variable at a time. ";
  const answer = sentence.repeat(8).trim();
  const result = condenseAnswerForDiscord(answer);

  assert.equal(result, answer);
  assert.ok(result.length >= 700 && result.length <= 1_200);
});

test("enforces the hard maximum without cutting off mid-sentence", () => {
  const answer = Array.from(
    { length: 30 },
    (_, index) =>
      `Tip ${index + 1} explains a distinct wet-driving adjustment while keeping the kart balanced and the driver consistent.`,
  ).join(" ");
  const result = condenseAnswerForDiscord(answer);

  assert.ok(result.length <= MAX_ORACLE_ANSWER_CHARACTERS);
  assert.match(result, /[.!?]$/);
  assert.ok(!result.endsWith("..."));
  assert.match(result, /^Tip 1/);
});

test("intelligently removes unnecessary structure, repetition, and follow-up", () => {
  const section = `**A. Short answer**
Generally, use the wider wet line because it often has less polished rubber and more grip.

**B. When it helps**
Brake earlier and make smoother steering inputs so the kart stays balanced.

**C. Summary**
In summary, use the wider wet line because it often has less polished rubber and more grip.

Would you like me to explain wet tyre pressures too?`;
  const result = condenseAnswerForDiscord(`${section}\n\n`.repeat(8), 420);

  assert.ok(result.length <= 420);
  assert.match(result, /^Generally/);
  assert.ok(!result.includes("**A."));
  assert.ok(!result.includes("Would you like"));
  assert.equal(
    result.match(/wider wet line because it often has less polished rubber/g)
      ?.length,
    1,
  );
  assert.match(result, /[.!?]$/);
});

test("prompt guidance contains the requested complexity-based targets", () => {
  assert.match(ORACLE_BASE_INSTRUCTIONS, /300–700 characters/);
  assert.match(ORACLE_BASE_INSTRUCTIONS, /700–1,200 characters/);
  assert.match(ORACLE_BASE_INSTRUCTIONS, /below 1,500 characters/);
  assert.match(ORACLE_BASE_INSTRUCTIONS, /hard maximum is 1,800 characters/);
});
