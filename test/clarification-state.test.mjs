import assert from "node:assert/strict";
import test from "node:test";

import {
  createPendingClarification,
  isRepeatedClarification,
  PendingClarificationStore,
  resolvePendingClarification,
  updatePendingClarification,
} from "../dist/clarification-state.js";

const originalQuestion =
  "Are the karts at Silverton Petrol or Electric karts?";

test("a typo correction resolves and resumes the original fleet question", () => {
  const pending = createPendingClarification(
    originalQuestion,
    {
      missingInformation: "which Silverton karting venue the user means",
    },
    1_000,
  );

  const resolution = resolvePendingClarification(
    pending,
    "Sorry spelt it wrong. Silverstone karting",
  );

  assert.equal(resolution.isClarificationReply, true);
  assert.equal(resolution.resolved, true);
  assert.match(resolution.effectiveQuestion, /Are the karts at Silverton/i);
  assert.match(resolution.effectiveQuestion, /Silverstone karting/i);
});

test("Yes confirms the proposed venue and resumes the original question", () => {
  const firstPending = createPendingClarification(originalQuestion, {
    missingInformation: "which Silverton karting venue the user means",
  });
  const confirmationPending = updatePendingClarification(firstPending, {
    missingInformation: "confirmation of the corrected venue",
    candidateInterpretation: "Silverstone Karting at Silverstone Circuit",
  });

  const resolution = resolvePendingClarification(confirmationPending, "Yes");

  assert.equal(resolution.isClarificationReply, true);
  assert.equal(resolution.resolved, true);
  assert.match(resolution.effectiveQuestion, /petrol or electric/i);
  assert.match(
    resolution.effectiveQuestion,
    /Silverstone Karting at Silverstone Circuit/i,
  );
});

test("detects substantially repeated clarification loops", () => {
  const clarification = {
    missingInformation: "confirmation of the corrected venue",
    candidateInterpretation: "Silverstone Karting at Silverstone Circuit",
  };
  const pending = createPendingClarification(originalQuestion, clarification);

  assert.equal(isRepeatedClarification(pending, clarification), true);
  assert.equal(
    isRepeatedClarification(pending, {
      missingInformation: "please confirm the corrected venue",
      candidateInterpretation: "Do you mean Silverstone Karting at Silverstone Circuit?",
    }),
    true,
  );
});

test("pending state is isolated by guild and user and expires", () => {
  const store = new PendingClarificationStore(1_000);
  const pending = createPendingClarification(
    originalQuestion,
    { missingInformation: "venue" },
    5_000,
  );
  store.set("guild-a", "user-a", pending);

  assert.equal(store.get("guild-a", "user-a", 5_500), pending);
  assert.equal(store.get("guild-a", "user-b", 5_500), undefined);
  assert.equal(store.get("guild-b", "user-a", 5_500), undefined);
  assert.equal(store.get("guild-a", "user-a", 6_001), undefined);
});
