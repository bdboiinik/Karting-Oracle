import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyGenuineKartingIntent,
  formatNonsenseResponse,
  nonsenseProcessingPlan,
  NONSENSE_PROCESSING_PLAN,
  NONSENSE_RESPONSE,
  resolveIntentBeforeClarification,
} from "../dist/intent-gate.js";
import { createPendingClarification } from "../dist/clarification-state.js";

test("genuine, basic, and unusual karting questions continue normally", () => {
  for (const question of [
    "What should I eat before a karting race?",
    "What tyre pressures should I run?",
    "Why am I losing time in wet conditions?",
    "Is karting good exercise?",
    "Why does my kart feel happier in the rain?",
    "Can I eat with my helmet on between sessions?",
    "What food should I bring, and do I need my helmet?",
    "How do I clean a steering column?",
    "Can a dirty steering wheel make you ill?",
    "What should I eat before karting?",
    "Can karting make you dizzy?",
  ]) {
    assert.equal(classifyGenuineKartingIntent(question), "genuine", question);
  }
});

test("clear karting-word nonsense gets the fixed short response", () => {
  for (const question of [
    "Is a kart tyre an optimal breakfast?",
    "Can I use the steering column as a toothbrush?",
    "Can I eat a kart tyre?",
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
    dailyQuestionsConsumed: 1,
    allowClarification: false,
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

test("obvious nonsense is routed before clarification and expensive work", () => {
  const plan = nonsenseProcessingPlan(
    "Can I use the steering column as a toothbrush?",
  );

  assert.ok(plan);
  assert.equal(plan.allowClarification, false);
  assert.equal(plan.loadConversation, false);
  assert.equal(plan.loadKnowledge, false);
  assert.equal(plan.allowWebSearch, false);
  assert.equal(plan.generateFullAnswer, false);
  assert.equal(plan.dailyQuestionsConsumed, 1);
});

test("nonsense cannot become a clarification reply even when one is pending", () => {
  const pending = createPendingClarification(
    "Which steering component is making a noise?",
    { missingInformation: "the steering component" },
  );
  const result = resolveIntentBeforeClarification(
    "Can I use the steering column as a toothbrush?",
    pending,
  );

  assert.equal(result.outcome, "reject_nonsense");
  assert.equal("clarification" in result, false);
  assert.equal(result.plan.allowClarification, false);
});

test("plausibly serious unusual questions have no early rejection plan", () => {
  for (const question of [
    "How do I clean a steering column?",
    "Can a dirty steering wheel make you ill?",
    "What should I eat before karting?",
    "Can karting make you dizzy?",
  ]) {
    assert.equal(nonsenseProcessingPlan(question), undefined, question);
  }
});
