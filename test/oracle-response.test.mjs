import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOracleInput,
  parseOracleResponse,
} from "../dist/oracle-response.js";

const knowledge = [
  {
    answerId: "550e8400-e29b-41d4-a716-446655440000",
    questionText: "How should I approach a wet corner?",
    answerText: "Use smooth inputs and build grip progressively.",
    relevance: 0.5,
  },
];

test("supplies only selected verified knowledge as model context", () => {
  const input = buildOracleInput("How do I drive in the rain?", knowledge);

  assert.match(input, /Verified community knowledge:/);
  assert.match(input, /Use smooth inputs/);
  assert.ok(!input.includes(knowledge[0].answerId));
  assert.ok(!input.includes(String(knowledge[0].relevance)));
});

test("does not claim verified knowledge was used when none was available", () => {
  const parsed = parseOracleResponse(
    JSON.stringify({
      answer: "Answer normally.",
      used_verified_knowledge: true,
    }),
    false,
  );

  assert.deepEqual(parsed, {
    text: "Answer normally.",
    usedVerifiedKnowledge: false,
  });
});

test("rejects invalid structured model output", () => {
  assert.throws(
    () => parseOracleResponse("not json", true),
    /invalid structured response/,
  );
});
