import assert from "node:assert/strict";
import test from "node:test";

import {
  redactSensitiveText,
  safeErrorDetails,
} from "../dist/safe-diagnostics.js";

test("redacts API credentials from diagnostic messages", () => {
  const openAIKey = "sk-example_secret_value_123456";
  const supabaseKey = "sb_secret_example_secret_value";
  const output = redactSensitiveText(
    `Authorization: Bearer ${openAIKey}; database=${supabaseKey}`,
  );

  assert.ok(!output.includes(openAIKey));
  assert.ok(!output.includes(supabaseKey));
  assert.match(output, /REDACTED/);
});

test("logs useful OpenAI error fields without serializing the whole object", () => {
  const output = safeErrorDetails({
    status: 429,
    code: "rate_limit_exceeded",
    type: "requests",
    message: "Rate limit reached for Bearer sk-example_secret_value_123456",
    unsafeBody: { token: "must-not-be-serialized" },
  });

  assert.match(output, /429/);
  assert.match(output, /rate_limit_exceeded/);
  assert.ok(!output.includes("sk-example_secret_value_123456"));
  assert.ok(!output.includes("must-not-be-serialized"));
});
