import assert from "node:assert/strict";
import test from "node:test";

import {
  answerEditIdFromCustomId,
  buildAnswerEditModal,
  buildModeratorAnswerButtons,
} from "../dist/answer-editing.js";

const answerId = "550e8400-e29b-41d4-a716-446655440000";

test("parses answer edit button and modal IDs", () => {
  const customId = `karting-oracle-answer-edit:v5:${answerId}`;

  assert.equal(answerEditIdFromCustomId(customId), answerId);
  assert.equal(buildAnswerEditModal(answerId, "Original answer").toJSON().custom_id, customId);
  assert.equal(answerEditIdFromCustomId("karting-oracle-answer-edit:v5:bad"), undefined);
});

test("places Edit Answer beside the verification action", () => {
  const row = buildModeratorAnswerButtons(answerId, false).toJSON();

  assert.deepEqual(
    row.components.map((component) => component.label),
    ["Verify Answer", "Edit Answer"],
  );
});
