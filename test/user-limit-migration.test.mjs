import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260902000000_add_user_question_limit_overrides.sql",
  import.meta.url,
);

test("user-limit migration is isolated by guild and user", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /create table if not exists public\.user_question_limit_overrides/i);
  assert.match(sql, /primary key \(discord_guild_id, discord_user_id\)/i);
  assert.match(sql, /daily_limit integer not null check \(daily_limit >= 0\)/i);
  assert.match(sql, /user_limit\.discord_guild_id = target_discord_guild_id/i);
  assert.match(sql, /user_limit\.discord_user_id = target_discord_user_id/i);
});

test("user-limit migration preserves usage and gives overrides precedence", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const reserveStart = sql.indexOf(
    "create or replace function public.reserve_daily_question",
  );
  const reserveSql = sql.slice(reserveStart);

  assert.ok(reserveStart >= 0);
  assert.ok(
    reserveSql.indexOf("select user_limit.daily_limit") <
      reserveSql.indexOf("select guild_limit.daily_limit"),
  );
  assert.match(reserveSql, /if not found then/i);
  assert.match(reserveSql, /configured_limit\s*=\s*0/i);
  assert.ok(
    reserveSql.indexOf("insert into public.daily_question_usage") <
      reserveSql.indexOf("if configured_limit is not null"),
    "usage is reserved even while the effective limit is unlimited",
  );
  assert.doesNotMatch(sql, /truncate\s+public\.daily_question_usage/i);
  assert.doesNotMatch(sql, /delete from public\.daily_question_usage/i);
});

test("user-limit functions and table are restricted to the service role", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  for (const functionName of [
    "get_user_question_limit_status",
    "set_user_question_limit",
    "reset_user_question_limit",
    "reserve_daily_question",
  ]) {
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${functionName}`),
    );
  }
  assert.match(sql, /alter table public\.user_question_limit_overrides enable row level security/i);
  assert.match(sql, /to service_role/i);
});
