-- Karting Oracle V3 persistence schema.
-- Discord snowflakes are stored as text because they exceed JavaScript's safe integer range.

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  discord_message_id text not null unique,
  discord_user_id text not null,
  question_text text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  discord_message_id text unique,
  answer_text text not null,
  created_at timestamptz not null default now(),
  is_verified boolean not null default false
);

comment on column public.answers.discord_message_id is
  'Set immediately after Discord accepts the reply; null only while a reply is being sent.';

create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  answer_id uuid not null references public.answers (id) on delete cascade,
  discord_user_id text not null,
  vote_type text not null check (vote_type in ('helpful', 'not_helpful')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint votes_one_per_user_per_answer unique (answer_id, discord_user_id)
);

create index if not exists answers_question_id_idx on public.answers (question_id);
create index if not exists questions_discord_user_id_idx on public.questions (discord_user_id);

create or replace function public.set_oracle_vote_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists votes_set_updated_at on public.votes;

create trigger votes_set_updated_at
before update on public.votes
for each row
execute function public.set_oracle_vote_updated_at();

create or replace function public.get_answer_vote_totals(target_answer_id uuid)
returns table (helpful bigint, not_helpful bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(*) filter (where vote_type = 'helpful') as helpful,
    count(*) filter (where vote_type = 'not_helpful') as not_helpful
  from public.votes
  where answer_id = target_answer_id;
$$;

create or replace function public.record_answer_vote(
  target_answer_id uuid,
  target_discord_user_id text,
  target_vote_type text
)
returns table (previous_vote text, helpful bigint, not_helpful bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_vote text;
begin
  if target_vote_type not in ('helpful', 'not_helpful') then
    raise exception 'Invalid vote type.' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.answers
    where id = target_answer_id
  ) then
    raise exception 'Answer does not exist.' using errcode = 'P0002';
  end if;

  select vote_type
  into existing_vote
  from public.votes
  where answer_id = target_answer_id
    and discord_user_id = target_discord_user_id
  for update;

  insert into public.votes (answer_id, discord_user_id, vote_type)
  values (target_answer_id, target_discord_user_id, target_vote_type)
  on conflict (answer_id, discord_user_id)
  do update set vote_type = excluded.vote_type;

  return query
  select
    existing_vote,
    count(*) filter (where vote_type = 'helpful'),
    count(*) filter (where vote_type = 'not_helpful')
  from public.votes
  where answer_id = target_answer_id;
end;
$$;

alter table public.questions enable row level security;
alter table public.answers enable row level security;
alter table public.votes enable row level security;

revoke all privileges on table public.questions, public.answers, public.votes
from public, anon, authenticated;

grant select, insert, update, delete
on table public.questions, public.answers, public.votes
to service_role;

revoke all privileges on function public.get_answer_vote_totals(uuid)
from public, anon, authenticated;
revoke all privileges on function public.record_answer_vote(uuid, text, text)
from public, anon, authenticated;
revoke all privileges on function public.set_oracle_vote_updated_at()
from public, anon, authenticated;

grant execute on function public.get_answer_vote_totals(uuid) to service_role;
grant execute on function public.record_answer_vote(uuid, text, text) to service_role;
grant execute on function public.set_oracle_vote_updated_at() to service_role;
