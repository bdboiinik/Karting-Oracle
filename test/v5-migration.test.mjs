import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260827000000_add_oracle_v5_conversations_limits_knowledge_edits.sql",
  import.meta.url,
);

test("V5 migration contains persistence and atomic limit controls", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  for (const requiredDefinition of [
    "public.conversation_messages",
    "public.daily_question_usage",
    "public.guild_question_limits",
    "public.structured_knowledge",
    "public.answer_edit_history",
    "public.reserve_daily_question",
    "public.complete_daily_question",
    "public.release_daily_question",
    "public.edit_oracle_answer",
  ]) {
    assert.ok(sql.includes(requiredDefinition), `Missing ${requiredDefinition}`);
  }

  assert.match(sql, /discord_guild_id,\s*discord_user_id,\s*created_at desc/s);
  assert.match(sql, /original_answer_text/);
  assert.match(sql, /reserved_questions/);
  assert.match(sql, /is_verified = false/);
});
