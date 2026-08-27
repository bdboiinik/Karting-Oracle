import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260827010000_add_karting_web_retrieval_cache.sql",
  import.meta.url,
);

test("web cache migration is isolated, expiring, and service-role only", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /public\.web_retrieval_cache/);
  assert.match(sql, /expires_at timestamptz not null/);
  assert.match(sql, /fact_type in/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all privileges[\s\S]*anon, authenticated/);
  assert.match(sql, /grant select, insert, update, delete[\s\S]*service_role/);
  assert.doesNotMatch(sql, /insert into public\.structured_knowledge/i);
  assert.doesNotMatch(sql, /update public\.answers/i);
});
