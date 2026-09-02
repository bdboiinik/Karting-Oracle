import assert from "node:assert/strict";
import test from "node:test";

import {
  memberHasModeratorRole,
  parseModeratorRoleIds,
  resolveModeratorRoleIds,
} from "../dist/moderator-roles.js";

test("parses, trims, deduplicates, and ignores empty moderator role IDs", () => {
  assert.deepEqual(
    [...parseModeratorRoleIds(" 123456789, ,987654321,123456789, ")],
    ["123456789", "987654321"],
  );
});

test("accepts a member with any configured moderator role", () => {
  const configured = new Set(["123456789", "987654321", "555555555"]);

  assert.equal(
    memberHasModeratorRole(["111111111", "987654321"], configured),
    true,
  );
  assert.equal(
    memberHasModeratorRole(["111111111", "222222222"], configured),
    false,
  );
});

test("configured moderators can manage user limits and non-moderators cannot", () => {
  const configured = new Set(["oracle-moderator"]);

  assert.equal(
    memberHasModeratorRole(["member", "oracle-moderator"], configured),
    true,
  );
  assert.equal(memberHasModeratorRole(["member"], configured), false);
});

test("uses the singular moderator role variable as a legacy fallback", () => {
  assert.deepEqual(
    [...resolveModeratorRoleIds({ MODERATOR_ROLE_ID: " 123456789 " })],
    ["123456789"],
  );
});

test("prefers the plural moderator role variable when both are set", () => {
  assert.deepEqual(
    [
      ...resolveModeratorRoleIds({
        MODERATOR_ROLE_IDS: "987654321,555555555",
        MODERATOR_ROLE_ID: "123456789",
      }),
    ],
    ["987654321", "555555555"],
  );
});

test("rejects invalid or missing moderator role configuration", () => {
  assert.throws(
    () => parseModeratorRoleIds("123456789,not-a-role"),
    /numeric Discord role IDs/,
  );
  assert.throws(
    () => resolveModeratorRoleIds({ MODERATOR_ROLE_IDS: " , " }),
    /Missing required environment variable/,
  );
});
