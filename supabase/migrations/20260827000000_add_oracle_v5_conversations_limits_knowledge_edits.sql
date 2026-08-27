-- Karting Oracle V5 conversations, limits, structured knowledge, and answer edits.
-- Additive migration: preserves all V3/V4 data and is safe to run more than once.

alter table public.questions
  add column if not exists discord_guild_id text;

create index if not exists questions_guild_user_created_idx
on public.questions (discord_guild_id, discord_user_id, created_at desc);

alter table public.answers
  add column if not exists original_answer_text text,
  add column if not exists edited_by_discord_user_id text,
  add column if not exists edited_at timestamptz;

update public.answers
set original_answer_text = answer_text
where original_answer_text is null;

create or replace function public.set_oracle_answer_original_text()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.original_answer_text = coalesce(new.original_answer_text, new.answer_text);
  return new;
end;
$$;

drop trigger if exists answers_set_original_text on public.answers;

create trigger answers_set_original_text
before insert on public.answers
for each row
execute function public.set_oracle_answer_original_text();

alter table public.answers
  alter column original_answer_text set not null;

create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  discord_guild_id text not null,
  discord_user_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (btrim(content) <> ''),
  question_id uuid unique references public.questions (id) on delete cascade,
  answer_id uuid unique references public.answers (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint conversation_message_source_check check (
    (role = 'user' and question_id is not null and answer_id is null)
    or (role = 'assistant' and question_id is null and answer_id is not null)
  )
);

create index if not exists conversation_messages_scope_created_idx
on public.conversation_messages (
  discord_guild_id,
  discord_user_id,
  created_at desc,
  id desc
);

create table if not exists public.guild_question_limits (
  discord_guild_id text primary key,
  daily_limit integer check (daily_limit is null or daily_limit > 0),
  updated_by_discord_user_id text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_question_usage (
  discord_guild_id text not null,
  discord_user_id text not null,
  usage_date date not null,
  successful_questions integer not null default 0 check (successful_questions >= 0),
  reserved_questions integer not null default 0 check (reserved_questions >= 0),
  updated_at timestamptz not null default now(),
  primary key (discord_guild_id, discord_user_id, usage_date)
);

alter table public.daily_question_usage
  add column if not exists reserved_questions integer not null default 0
    check (reserved_questions >= 0);

create table if not exists public.structured_knowledge (
  id uuid primary key default gen_random_uuid(),
  title text not null check (btrim(title) <> ''),
  category text not null check (
    category in (
      'discount_codes',
      'recommended_gear',
      'brads_gear',
      'events_schedule',
      'links',
      'general_karting'
    )
  ),
  content text not null check (btrim(content) <> ''),
  url text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_by text not null,
  updated_at timestamptz not null default now(),
  active boolean not null default true
);

create index if not exists structured_knowledge_active_search_idx
on public.structured_knowledge
using gin (
  to_tsvector(
    'english',
    title || ' ' || replace(category, '_', ' ') || ' ' || content
  )
)
where active = true;

create table if not exists public.answer_edit_history (
  id uuid primary key default gen_random_uuid(),
  answer_id uuid not null references public.answers (id) on delete cascade,
  previous_answer_text text not null,
  edited_answer_text text not null,
  edited_by_discord_user_id text not null,
  edited_at timestamptz not null default now()
);

create index if not exists answer_edit_history_answer_created_idx
on public.answer_edit_history (answer_id, edited_at desc);

create or replace function public.append_conversation_exchange(
  target_discord_guild_id text,
  target_discord_user_id text,
  target_question_id uuid,
  target_answer_id uuid,
  target_question_text text,
  target_answer_text text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if target_discord_guild_id is null or btrim(target_discord_guild_id) = ''
    or target_discord_user_id is null or btrim(target_discord_user_id) = '' then
    raise exception 'Discord guild and user IDs are required.' using errcode = '22023';
  end if;

  insert into public.conversation_messages (
    discord_guild_id,
    discord_user_id,
    role,
    content,
    question_id
  )
  values (
    target_discord_guild_id,
    target_discord_user_id,
    'user',
    target_question_text,
    target_question_id
  )
  on conflict (question_id) do nothing;

  insert into public.conversation_messages (
    discord_guild_id,
    discord_user_id,
    role,
    content,
    answer_id
  )
  values (
    target_discord_guild_id,
    target_discord_user_id,
    'assistant',
    target_answer_text,
    target_answer_id
  )
  on conflict (answer_id) do nothing;
end;
$$;

create or replace function public.set_guild_question_limit(
  target_discord_guild_id text,
  target_daily_limit integer,
  target_discord_moderator_user_id text
)
returns table (daily_limit integer, updated_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if target_discord_guild_id is null or btrim(target_discord_guild_id) = ''
    or target_discord_moderator_user_id is null
    or btrim(target_discord_moderator_user_id) = '' then
    raise exception 'Discord guild and moderator IDs are required.' using errcode = '22023';
  end if;

  if target_daily_limit is not null and target_daily_limit <= 0 then
    raise exception 'Daily limit must be positive or null.' using errcode = '22023';
  end if;

  insert into public.guild_question_limits (
    discord_guild_id,
    daily_limit,
    updated_by_discord_user_id,
    updated_at
  )
  values (
    target_discord_guild_id,
    target_daily_limit,
    target_discord_moderator_user_id,
    now()
  )
  on conflict (discord_guild_id)
  do update set
    daily_limit = excluded.daily_limit,
    updated_by_discord_user_id = excluded.updated_by_discord_user_id,
    updated_at = excluded.updated_at;

  return query
  select setting.daily_limit, setting.updated_at
  from public.guild_question_limits as setting
  where setting.discord_guild_id = target_discord_guild_id;
end;
$$;

create or replace function public.reserve_daily_question(
  target_discord_guild_id text,
  target_discord_user_id text
)
returns table (
  allowed boolean,
  daily_limit integer,
  used integer,
  remaining integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  configured_limit integer;
  current_usage integer;
  current_reserved integer;
  current_usage_date date := (now() at time zone 'UTC')::date;
begin
  select setting.daily_limit
  into configured_limit
  from public.guild_question_limits as setting
  where setting.discord_guild_id = target_discord_guild_id;

  if configured_limit is null then
    return query select true, null::integer, 0, null::integer;
    return;
  end if;

  insert into public.daily_question_usage (
    discord_guild_id,
    discord_user_id,
    usage_date,
    successful_questions
  )
  values (
    target_discord_guild_id,
    target_discord_user_id,
    current_usage_date,
    0
  )
  on conflict (discord_guild_id, discord_user_id, usage_date) do nothing;

  select usage.successful_questions, usage.reserved_questions
  into current_usage, current_reserved
  from public.daily_question_usage as usage
  where usage.discord_guild_id = target_discord_guild_id
    and usage.discord_user_id = target_discord_user_id
    and usage.usage_date = current_usage_date
  for update;

  if current_reserved > 0 and exists (
    select 1
    from public.daily_question_usage as usage
    where usage.discord_guild_id = target_discord_guild_id
      and usage.discord_user_id = target_discord_user_id
      and usage.usage_date = current_usage_date
      and usage.updated_at < now() - interval '15 minutes'
  ) then
    update public.daily_question_usage as usage
    set reserved_questions = 0, updated_at = now()
    where usage.discord_guild_id = target_discord_guild_id
      and usage.discord_user_id = target_discord_user_id
      and usage.usage_date = current_usage_date;
    current_reserved := 0;
  end if;

  if current_usage + current_reserved >= configured_limit then
    return query
    select
      false,
      configured_limit,
      current_usage,
      greatest(configured_limit - current_usage - current_reserved, 0);
    return;
  end if;

  update public.daily_question_usage as usage
  set
    reserved_questions = usage.reserved_questions + 1,
    updated_at = now()
  where usage.discord_guild_id = target_discord_guild_id
    and usage.discord_user_id = target_discord_user_id
    and usage.usage_date = current_usage_date
  returning usage.reserved_questions into current_reserved;

  return query
  select
    true,
    configured_limit,
    current_usage,
    greatest(configured_limit - current_usage - current_reserved, 0);
end;
$$;

create or replace function public.complete_daily_question(
  target_discord_guild_id text,
  target_discord_user_id text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.daily_question_usage as usage
  set
    reserved_questions = usage.reserved_questions - 1,
    successful_questions = usage.successful_questions + 1,
    updated_at = now()
  where usage.discord_guild_id = target_discord_guild_id
    and usage.discord_user_id = target_discord_user_id
    and usage.usage_date = (now() at time zone 'UTC')::date
    and usage.reserved_questions > 0;

  if not found then
    raise exception 'No daily question reservation exists.' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.release_daily_question(
  target_discord_guild_id text,
  target_discord_user_id text
)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.daily_question_usage as usage
  set
    reserved_questions = greatest(usage.reserved_questions - 1, 0),
    updated_at = now()
  where usage.discord_guild_id = target_discord_guild_id
    and usage.discord_user_id = target_discord_user_id
    and usage.usage_date = (now() at time zone 'UTC')::date;
$$;

create or replace function public.search_structured_knowledge(
  search_query text,
  result_limit integer default 4
)
returns table (
  knowledge_id uuid,
  title text,
  category text,
  content text,
  url text,
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
    knowledge.id as knowledge_id,
    knowledge.title,
    knowledge.category,
    knowledge.content,
    knowledge.url,
    ts_rank_cd(
      to_tsvector(
        'english',
        knowledge.title || ' ' || replace(knowledge.category, '_', ' ') || ' ' || knowledge.content
      ),
      parsed_query.value
    )::real as relevance
  from public.structured_knowledge as knowledge
  cross join parsed_query
  where knowledge.active = true
    and parsed_query.value @@ to_tsvector(
      'english',
      knowledge.title || ' ' || replace(knowledge.category, '_', ' ') || ' ' || knowledge.content
    )
  order by relevance desc, knowledge.updated_at desc
  limit greatest(1, least(coalesce(result_limit, 4), 8));
$$;

create or replace function public.edit_oracle_answer(
  target_answer_id uuid,
  target_answer_text text,
  target_discord_moderator_user_id text
)
returns table (
  answer_text text,
  is_verified boolean,
  edited_by_discord_user_id text,
  edited_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  previous_text text;
begin
  if target_answer_text is null or btrim(target_answer_text) = '' then
    raise exception 'Edited answer text is required.' using errcode = '22023';
  end if;

  if target_discord_moderator_user_id is null
    or btrim(target_discord_moderator_user_id) = '' then
    raise exception 'Discord moderator user ID is required.' using errcode = '22023';
  end if;

  select answer.answer_text
  into previous_text
  from public.answers as answer
  where answer.id = target_answer_id
  for update;

  if not found then
    raise exception 'Answer does not exist.' using errcode = 'P0002';
  end if;

  if previous_text = btrim(target_answer_text) then
    raise exception 'The edited answer is unchanged.' using errcode = '22023';
  end if;

  insert into public.answer_edit_history (
    answer_id,
    previous_answer_text,
    edited_answer_text,
    edited_by_discord_user_id
  )
  values (
    target_answer_id,
    previous_text,
    btrim(target_answer_text),
    target_discord_moderator_user_id
  );

  update public.answers as answer
  set
    answer_text = btrim(target_answer_text),
    edited_by_discord_user_id = target_discord_moderator_user_id,
    edited_at = now(),
    is_verified = false,
    verified_by_discord_user_id = null,
    verified_at = null
  where answer.id = target_answer_id;

  return query
  select
    answer.answer_text,
    answer.is_verified,
    answer.edited_by_discord_user_id,
    answer.edited_at
  from public.answers as answer
  where answer.id = target_answer_id;
end;
$$;

alter table public.conversation_messages enable row level security;
alter table public.guild_question_limits enable row level security;
alter table public.daily_question_usage enable row level security;
alter table public.structured_knowledge enable row level security;
alter table public.answer_edit_history enable row level security;

revoke all privileges on table
  public.conversation_messages,
  public.guild_question_limits,
  public.daily_question_usage,
  public.structured_knowledge,
  public.answer_edit_history
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.conversation_messages,
  public.guild_question_limits,
  public.daily_question_usage,
  public.structured_knowledge,
  public.answer_edit_history
to service_role;

grant select, update on table public.questions, public.answers to service_role;

revoke all privileges on function public.append_conversation_exchange(text, text, uuid, uuid, text, text)
from public, anon, authenticated;
revoke all privileges on function public.set_guild_question_limit(text, integer, text)
from public, anon, authenticated;
revoke all privileges on function public.reserve_daily_question(text, text)
from public, anon, authenticated;
revoke all privileges on function public.release_daily_question(text, text)
from public, anon, authenticated;
revoke all privileges on function public.complete_daily_question(text, text)
from public, anon, authenticated;
revoke all privileges on function public.search_structured_knowledge(text, integer)
from public, anon, authenticated;
revoke all privileges on function public.edit_oracle_answer(uuid, text, text)
from public, anon, authenticated;
revoke all privileges on function public.set_oracle_answer_original_text()
from public, anon, authenticated;

grant execute on function public.append_conversation_exchange(text, text, uuid, uuid, text, text)
to service_role;
grant execute on function public.set_guild_question_limit(text, integer, text)
to service_role;
grant execute on function public.reserve_daily_question(text, text)
to service_role;
grant execute on function public.release_daily_question(text, text)
to service_role;
grant execute on function public.complete_daily_question(text, text)
to service_role;
grant execute on function public.search_structured_knowledge(text, integer)
to service_role;
grant execute on function public.edit_oracle_answer(uuid, text, text)
to service_role;
grant execute on function public.set_oracle_answer_original_text()
to service_role;
