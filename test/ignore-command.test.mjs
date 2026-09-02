import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIgnoreCommandResult,
  IGNORE_PROCESSING_PLAN,
} from "../dist/ignore-command.js";

test("/oracle ignore renders attributed public chat in the Oracle channel", () => {
  assert.deepEqual(
    buildIgnoreCommandResult(
      "oracle-channel",
      "oracle-channel",
      "user-123",
      " Yeah mate I'll be there Sunday ",
    ),
    {
      allowed: true,
      content: "💬 <@user-123>: Yeah mate I'll be there Sunday",
    },
  );
});

test("/oracle ignore is refused outside the configured Oracle channel", () => {
  const result = buildIgnoreCommandResult(
    "oracle-channel",
    "other-channel",
    "user-123",
    "Normal chat",
  );

  assert.equal(result.allowed, false);
  assert.match(result.content, /only available in the configured Oracle channel/i);
});

test("/oracle ignore bypasses every Oracle processing side effect", () => {
  assert.deepEqual(IGNORE_PROCESSING_PLAN, {
    classifyIntent: false,
    loadConversation: false,
    loadKnowledge: false,
    callOpenAI: false,
    allowWebSearch: false,
    storeConversation: false,
    consumeDailyQuestion: false,
    alterConversationContext: false,
  });
});
