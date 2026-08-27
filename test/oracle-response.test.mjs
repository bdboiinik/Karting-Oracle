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

const structuredKnowledge = [
  {
    id: "550e8400-e29b-41d4-a716-446655440001",
    title: "Oracle partner code",
    category: "discount_codes",
    content: "Use ORACLE10 for the documented partner shop.",
    url: "https://example.com/shop",
    relevance: 0.8,
  },
];

test("supplies only selected verified knowledge as model context", () => {
  const input = buildOracleInput("How do I drive in the rain?", knowledge);

  assert.match(input, /Verified community knowledge:/);
  assert.match(input, /Use smooth inputs/);
  assert.ok(!input.includes(knowledge[0].answerId));
  assert.ok(!input.includes(String(knowledge[0].relevance)));
});

test("supplies structured knowledge and isolated conversation context", () => {
  const conversation = [
    {
      discordGuildId: "guild-1",
      discordUserId: "user-1",
      role: "user",
      content: "Compare the two helmets.",
      createdAt: "2026-08-27T10:00:00.000Z",
    },
  ];
  const input = buildOracleInput(
    "What about the other one?",
    [],
    structuredKnowledge,
    conversation,
  );

  assert.match(input, /Authoritative structured Oracle knowledge/);
  assert.match(input, /ORACLE10/);
  assert.match(input, /Compare the two helmets/);
  assert.ok(!input.includes(structuredKnowledge[0].id));
});

test("does not claim verified knowledge was used when none was available", () => {
  const parsed = parseOracleResponse(
    JSON.stringify({
      answer: "Answer normally.",
      is_karting_related: true,
      used_verified_knowledge: true,
      used_structured_knowledge: false,
    }),
    false,
  );

  assert.deepEqual(parsed, {
    text: "Answer normally.",
    isKartingRelated: true,
    usedVerifiedKnowledge: false,
    usedStructuredKnowledge: false,
  });
});

test("rejects invalid structured model output", () => {
  assert.throws(
    () => parseOracleResponse("not json", true),
    /invalid structured response/,
  );
});
