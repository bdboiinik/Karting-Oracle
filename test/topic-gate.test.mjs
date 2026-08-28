import assert from "node:assert/strict";
import test from "node:test";

import { classifyTopic, OFF_TOPIC_RESPONSE } from "../dist/topic-gate.js";

test("rejects obvious unrelated requests without conversation context", () => {
  assert.equal(classifyTopic("Write my Python homework", false, false), "obviously_off_topic");
  assert.equal(classifyTopic("What is the capital of France?", false, false), "obviously_off_topic");
  assert.match(OFF_TOPIC_RESPONSE, /only help with karting-related questions/);
});

test("allows karting-related outside information and ambiguous follow-ups", () => {
  assert.equal(
    classifyTopic("How will wet weather affect kart tyre pressures?", false, false),
    "karting",
  );
  assert.equal(classifyTopic("What about the other one?", true, false), "karting");
  assert.equal(
    classifyTopic("When is BRKC held based on past years?", false, false),
    "karting",
  );
});

test("still rejects explicit off-topic requests after a karting conversation", () => {
  assert.equal(classifyTopic("What was the football score?", true, false), "obviously_off_topic");
});
