-- Karting Oracle V4 moderator verification and verified knowledge retrieval.
-- This migration is safe to run more than once.

alter table public.answers
  add column if not exists is_verified boolean not null default false,
  add column if not exists verified_by_discord_user_id text,
  add column if not exists verified_at timestamptz;

comment on column public.answers.verified_by_discord_user_id is
  'Discord user ID of the moderator who most recently verified this answer.';

comment on column public.answers.verified_at is
  'Database timestamp of the most recent verification; cleared when unverified.';

create index if not exists answers_verified_answer_text_search_idx
on public.answers
using gin (to_tsvector('english', answer_text))
where is_verified = true;

create index if not exists questions_question_text_search_idx
on public.questions
using gin (to_tsvector('english', question_text));

create or replace function public.set_answer_verification(
  target_answer_id uuid,
  target_is_verified boolean,
  target_discord_user_id text
)
returns table (
  is_verified boolean,
  verified_by_discord_user_id text,
  verified_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if target_discord_user_id is null or btrim(target_discord_user_id) = '' then
    raise exception 'Discord moderator user ID is required.' using errcode = '22023';
  end if;

  update public.answers as answer
  set
    is_verified = target_is_verified,
    verified_by_discord_user_id = case
      when target_is_verified then target_discord_user_id
      else null
    end,
    verified_at = case
      when target_is_verified then now()
      else null
    end
  where answer.id = target_answer_id;

  if not found then
    raise exception 'Answer does not exist.' using errcode = 'P0002';
  end if;

  return query
  select
    answer.is_verified,
    answer.verified_by_discord_user_id,
    answer.verified_at
  from public.answers as answer
  where answer.id = target_answer_id;
end;
$$;

create or replace function public.search_verified_knowledge(
  search_query text,
  result_limit integer default 3
)
returns table (
  answer_id uuid,
  question_text text,
  answer_text text,
  relevance real
)
language sql
stable
security invoker
set search_path = ''
as $$
  with parsed_query as (
    select websearch_to_tsquery(
      'english',
      left(coalesce(nullif(btrim(search_query), ''), 'no-search-terms'), 500)
    ) as value
  )
  select
    answer.id as answer_id,
    question.question_text,
    answer.answer_text,
    (
      ts_rank_cd(
        to_tsvector('english', question.question_text),
        parsed_query.value
      ) * 2
      + ts_rank_cd(
        to_tsvector('english', answer.answer_text),
        parsed_query.value
      )
    )::real as relevance
  from public.answers as answer
  join public.questions as question on question.id = answer.question_id
  cross join parsed_query
  where answer.is_verified = true
    and (
      parsed_query.value @@ to_tsvector('english', question.question_text)
      or parsed_query.value @@ to_tsvector('english', answer.answer_text)
    )
  order by relevance desc, answer.verified_at desc nulls last, answer.created_at desc
  limit greatest(1, least(coalesce(result_limit, 3), 5));
$$;

revoke all privileges on function public.set_answer_verification(uuid, boolean, text)
from public, anon, authenticated;

revoke all privileges on function public.search_verified_knowledge(text, integer)
from public, anon, authenticated;

grant execute on function public.set_answer_verification(uuid, boolean, text)
to service_role;

grant execute on function public.search_verified_knowledge(text, integer)
to service_role;

grant select, update on table public.answers to service_role;
