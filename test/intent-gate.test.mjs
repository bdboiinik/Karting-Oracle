import assert from "node:assert/strict";
import test from "node:test";

import { createPendingClarification } from "../dist/clarification-state.js";
import {
  formatTerminalIntentResponse,
  NONSENSE_RESPONSE,
  resolveClassifiedIntentBeforeClarification,
} from "../dist/intent-gate.js";

function classified(classification, safetyCategory = "none") {
  return { classification, safetyCategory };
}

test("genuine and genuinely uncertain karting intents continue normally", () => {
  for (const [question, classification] of [
    ["How can a beginner improve wet-weather braking?", "GENUINE_KARTING"],
    ["Can karting make someone feel dizzy?", "GENUINE_KARTING"],
    ["How should a steering column be cleaned safely?", "GENUINE_KARTING"],
    ["What about the other chassis?", "UNCERTAIN"],
  ]) {
    const result = resolveClassifiedIntentBeforeClarification(
      classified(classification),
      question,
      undefined,
    );
    assert.equal(result.outcome, "continue", question);
  }
});

test("different trolling and absurd-misuse intents stop immediately", () => {
  const unseenVariants = [
    "Could a sprocket double as my dinner plate?",
    "Would fitting balloons make my kart fly to the moon?",
    "Should I challenge my brake pedal to a wrestling match?",
  ];

  for (const question of unseenVariants) {
    const result = resolveClassifiedIntentBeforeClarification(
      classified("NONSENSE_OR_TROLLING"),
      question,
      undefined,
    );

    assert.equal(result.outcome, "respond", question);
    assert.equal(result.plan.response, NONSENSE_RESPONSE);
    assert.equal(result.plan.dailyQuestionsConsumed, 1);
    assert.equal(result.plan.allowClarification, false);
    assert.equal(result.plan.loadConversation, false);
    assert.equal(result.plan.loadKnowledge, false);
    assert.equal(result.plan.allowWebSearch, false);
    assert.equal(result.plan.generateFullAnswer, false);
  }
});

test("obvious nonsense cannot become a clarification reply", () => {
  const pending = createPendingClarification(
    "Which steering component is making a noise?",
    { missingInformation: "the steering component" },
  );
  const result = resolveClassifiedIntentBeforeClarification(
    classified("NONSENSE_OR_TROLLING"),
    "Could I teach that component to sing opera?",
    pending,
  );

  assert.equal(result.outcome, "respond");
  assert.equal("clarification" in result, false);
});

test("nonsense consumes exactly one question and shows remaining allowance", () => {
  const result = resolveClassifiedIntentBeforeClarification(
    classified("NONSENSE_OR_TROLLING"),
    "An absurd prompt not listed in production instructions",
    undefined,
  );
  assert.equal(result.outcome, "respond");
  assert.equal(result.plan.dailyQuestionsConsumed, 1);

  const response = formatTerminalIntentResponse(result.plan, {
    allowed: true,
    dailyLimit: 20,
    used: 1,
    remaining: 18,
  });
  assert.match(response, /Nice try/);
  assert.match(response, /Daily questions remaining: 18/);
});

test("off-topic intent uses the existing response without consuming allowance", () => {
  const result = resolveClassifiedIntentBeforeClarification(
    classified("OFF_TOPIC"),
    "Explain a non-karting subject",
    undefined,
  );

  assert.equal(result.outcome, "respond");
  assert.match(result.plan.response, /only help with karting-related questions/i);
  assert.equal(result.plan.dailyQuestionsConsumed, 0);
});

test("safety-sensitive ingestion gets only a short fixed safety response", () => {
  const result = resolveClassifiedIntentBeforeClarification(
    classified("SAFETY_SENSITIVE", "chemical_ingestion"),
    "Could someone swallow a liquid from the kart workshop?",
    undefined,
  );

  assert.equal(result.outcome, "respond");
  assert.equal(result.plan.dailyQuestionsConsumed, 1);
  assert.equal(result.plan.allowClarification, false);
  assert.equal(result.plan.allowWebSearch, false);
  assert.equal(result.plan.generateFullAnswer, false);
  assert.match(result.plan.response, /unsafe to ingest/i);
  assert.match(result.plan.response, /urgent medical or poison-control advice/i);
  assert.ok(result.plan.response.length < 240);

  assert.match(
    formatTerminalIntentResponse(result.plan, {
      allowed: true,
      dailyLimit: 5,
      used: 4,
      remaining: 0,
    }),
    /⏳ Daily questions remaining: 0/,
  );
});
