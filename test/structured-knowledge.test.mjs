import assert from "node:assert/strict";
import test from "node:test";

import {
  isKnowledgeCategory,
  normalizeOptionalKnowledgeUrl,
  renderKnowledgeItem,
} from "../dist/structured-knowledge.js";

test("accepts every supported structured knowledge category", () => {
  for (const category of [
    "discount_codes",
    "recommended_gear",
    "brads_gear",
    "events_schedule",
    "links",
    "general_karting",
  ]) {
    assert.equal(isKnowledgeCategory(category), true);
  }
  assert.equal(isKnowledgeCategory("general_trivia"), false);
});

test("validates and clears optional knowledge URLs", () => {
  assert.equal(
    normalizeOptionalKnowledgeUrl("https://example.com/shop"),
    "https://example.com/shop",
  );
  assert.equal(normalizeOptionalKnowledgeUrl("none"), undefined);
  assert.throws(() => normalizeOptionalKnowledgeUrl("javascript:alert(1)"), /HTTP/);
});

test("renders moderator knowledge details with an ID", () => {
  const rendered = renderKnowledgeItem({
    id: "550e8400-e29b-41d4-a716-446655440000",
    title: "Partner code",
    category: "discount_codes",
    content: "Use the stored code only.",
    url: undefined,
    isActive: true,
  });

  assert.match(rendered, /Partner code/);
  assert.match(rendered, /550e8400/);
});
