import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildIntentClassifierInput,
  buildIntentClassifierRequest,
  INTENT_CLASSIFICATIONS,
  INTENT_CLASSIFIER_INPUT_CHARACTER_LIMIT,
  INTENT_CLASSIFIER_INSTRUCTIONS,
  INTENT_CLASSIFIER_MAX_OUTPUT_TOKENS,
  INTENT_CLASSIFIER_RESPONSE_FORMAT,
  parseIntentClassification,
} from "../dist/intent-classifier.js";

test("uses the five fixed semantic classification outcomes", () => {
  assert.deepEqual(INTENT_CLASSIFICATIONS, [
    "GENUINE_KARTING",
    "NONSENSE_OR_TROLLING",
    "OFF_TOPIC",
    "SAFETY_SENSITIVE",
    "UNCERTAIN",
  ]);
  assert.deepEqual(
    INTENT_CLASSIFIER_RESPONSE_FORMAT.schema.properties.classification.enum,
    INTENT_CLASSIFICATIONS,
  );
  assert.equal(INTENT_CLASSIFIER_RESPONSE_FORMAT.strict, true);
});

test("classifier prompt is semantic rather than an example phrase list", async () => {
  assert.match(INTENT_CLASSIFIER_INSTRUCTIONS, /semantic purpose/i);
  assert.match(INTENT_CLASSIFIER_INSTRUCTIONS, /primary intent/i);
  assert.match(INTENT_CLASSIFIER_INSTRUCTIONS, /unusual but plausible/i);
  assert.doesNotMatch(
    INTENT_CLASSIFIER_INSTRUCTIONS,
    /engine oil|toothbrush|cereal bowl|marry my kart/i,
  );

  const source = await readFile(
    new URL("../src/intent-classifier.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /new RegExp|\.test\(question\)/);
});

test("classifier receives only a small raw-message input", () => {
  const input = buildIntentClassifierInput(`  ${"x".repeat(2_000)}  `);

  assert.equal(input.length, INTENT_CLASSIFIER_INPUT_CHARACTER_LIMIT);
  assert.equal(INTENT_CLASSIFIER_INPUT_CHARACTER_LIMIT, 800);
  assert.equal(INTENT_CLASSIFIER_MAX_OUTPUT_TOKENS, 160);
  assert.doesNotMatch(input, /conversation|knowledge/i);
});

test("classifier request has no tools and uses minimal bounded generation", () => {
  const request = buildIntentClassifierRequest(
    "gpt-5-mini",
    "A single raw user message",
  );

  assert.equal(request.model, "gpt-5-mini");
  assert.equal(request.input, "A single raw user message");
  assert.equal(request.max_output_tokens, 160);
  assert.deepEqual(request.reasoning, { effort: "minimal" });
  assert.equal(request.store, false);
  assert.equal("tools" in request, false);
  assert.equal(request.text.format.type, "json_schema");
});

test("parses every valid category and only minimal safety metadata", () => {
  const cases = [
    ["GENUINE_KARTING", "none"],
    ["NONSENSE_OR_TROLLING", "none"],
    ["OFF_TOPIC", "none"],
    ["SAFETY_SENSITIVE", "chemical_ingestion"],
    ["UNCERTAIN", "none"],
  ];

  for (const [classification, safetyCategory] of cases) {
    assert.deepEqual(
      parseIntentClassification(
        JSON.stringify({
          classification,
          safety_category: safetyCategory,
        }),
      ),
      { classification, safetyCategory },
    );
  }
});

test("rejects invalid or inconsistent classifier output", () => {
  assert.throws(
    () => parseIntentClassification("not json"),
    /invalid intent classification/i,
  );
  assert.throws(
    () =>
      parseIntentClassification(
        JSON.stringify({
          classification: "SAFETY_SENSITIVE",
          safety_category: "none",
        }),
      ),
    /invalid intent classification/i,
  );
  assert.throws(
    () =>
      parseIntentClassification(
        JSON.stringify({
          classification: "GENUINE_KARTING",
          safety_category: "serious_injury",
        }),
      ),
    /invalid intent classification/i,
  );
  assert.throws(
    () =>
      parseIntentClassification(
        JSON.stringify({
          classification: "OFF_TOPIC",
          safety_category: "none",
          explanation: "not allowed",
        }),
      ),
    /invalid intent classification/i,
  );
});
