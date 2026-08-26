import assert from "node:assert/strict";
import test from "node:test";

import { verificationButtonFromCustomId } from "../dist/verification.js";

const answerId = "550e8400-e29b-41d4-a716-446655440000";

test("parses V4 verify and unverify button IDs", () => {
  assert.deepEqual(
    verificationButtonFromCustomId(
      `karting-oracle-verification:v4:verify:${answerId}`,
    ),
    { action: "verify", answerId },
  );
  assert.deepEqual(
    verificationButtonFromCustomId(
      `karting-oracle-verification:v4:unverify:${answerId}`,
    ),
    { action: "unverify", answerId },
  );
});

test("rejects malformed or forged verification button IDs", () => {
  assert.equal(
    verificationButtonFromCustomId(
      `karting-oracle-verification:v4:approve:${answerId}`,
    ),
    undefined,
  );
  assert.equal(
    verificationButtonFromCustomId(
      "karting-oracle-verification:v4:verify:not-a-uuid",
    ),
    undefined,
  );
  assert.equal(
    verificationButtonFromCustomId(
      `karting-oracle-verification:v4:verify:${answerId}:extra`,
    ),
    undefined,
  );
});
