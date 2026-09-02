import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyGenuineKartingIntent,
  formatNonsenseResponse,
  NONSENSE_PROCESSING_PLAN,
  NONSENSE_RESPONSE,
} from "../dist/intent-gate.js";

test("genuine, basic, and unusual karting questions continue normally", () => {
  for (const question of [
    "What should I eat before a karting race?",
    "What tyre pressures should I run?",
    "Why am I losing time in wet conditions?",
    "Is karting good exercise?",
    "Why does my kart feel happier in the rain?",
    "Can I eat with my helmet on between sessions?",
    "What food should I bring, and do I need my helmet?",
  ]) {
    assert.equal(classifyGenuineKartingIntent(question), "genuine", question);
  }
});

test("clear karting-word nonsense gets the fixed short response", () => {
  for (const question of [
    "Is a kart tyre an optimal breakfast?",
    "Can I marry my kart?",
    "Can I use my helmet as a cereal bowl?",
  ]) {
    assert.equal(
      classifyGenuineKartingIntent(question),
      "obvious_nonsense",
      question,
    );
  }

  assert.ok(NONSENSE_RESPONSE.length < 100);
});

test("nonsense consumes its reservation without retrieval or generation", () => {
  assert.deepEqual(NONSENSE_PROCESSING_PLAN, {
    consumeReservedQuestion: true,
    loadConversation: false,
    loadKnowledge: false,
    generateFullAnswer: false,
    allowWebSearch: false,
  });

  const response = formatNonsenseResponse({
    allowed: true,
    dailyLimit: 20,
    used: 1,
    remaining: 18,
  });
  assert.match(response, /Nice try/);
  assert.match(response, /Daily AI questions remaining: 18/);
  assert.equal(formatNonsenseResponse(undefined), "🏁 Nice try 😄");
});
