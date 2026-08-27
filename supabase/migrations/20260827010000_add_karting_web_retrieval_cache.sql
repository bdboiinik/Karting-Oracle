-- Karting Oracle selective public-web retrieval cache.
-- Cached rows remain separate from structured and moderator-verified knowledge.

create table if not exists public.web_retrieval_cache (
  cache_key text primary key
    check (char_length(cache_key) = 64),
  canonical_query text not null
    check (char_length(btrim(canonical_query)) between 1 and 500),
  fact_type text not null
    check (fact_type in (
      'location_address',
      'official_website',
      'contact_information',
      'opening_hours',
      'events_schedule',
      'current_fleet',
      'current_product',
      'other_current'
    )),
  fact_text text not null
    check (char_length(btrim(fact_text)) between 1 and 4000),
  answer_text text not null
    check (char_length(btrim(answer_text)) between 1 and 4000),
  sources jsonb not null default '[]'::jsonb
    check (jsonb_typeof(sources) = 'array'),
  used_verified_knowledge boolean not null default false,
  used_structured_knowledge boolean not null default false,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > fetched_at)
);

comment on table public.web_retrieval_cache is
  'Expiring public web facts used to avoid repeated karting-only lookups. Rows are not verified community knowledge.';

create index if not exists web_retrieval_cache_expires_at_idx
on public.web_retrieval_cache (expires_at);

alter table public.web_retrieval_cache enable row level security;

revoke all privileges on table public.web_retrieval_cache
from public, anon, authenticated;

grant select, insert, update, delete on table public.web_retrieval_cache
to service_role;
