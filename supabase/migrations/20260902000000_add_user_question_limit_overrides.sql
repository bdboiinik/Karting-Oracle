-- Per-user Karting Oracle daily-limit overrides.
-- Additive migration: existing guild limits and daily usage are preserved.

create table if not exists public.user_question_limit_overrides (
  discord_guild_id text not null,
  discord_user_id text not null,
  daily_limit integer not null check (daily_limit >= 0),
  updated_by_discord_user_id text not null,
  updated_at timestamptz not null default now(),
  primary key (discord_guild_id, discord_user_id)
);

create or replace function public.get_user_question_limit_status(
  target_discord_guild_id text,
  target_discord_user_id text
)
returns table (
  server_daily_limit integer,
  personal_daily_limit integer,
  effective_daily_limit integer,
  used integer,
  remaining integer,
  is_blocked boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with configured as (
    select
      guild_limit.daily_limit as server_daily_limit,
      user_limit.daily_limit as personal_daily_limit,
      coalesce(user_limit.daily_limit, guild_limit.daily_limit) as effective_daily_limit
    from (select 1) as seed
    left join public.guild_question_limits as guild_limit
      on guild_limit.discord_guild_id = target_discord_guild_id
    left join public.user_question_limit_overrides as user_limit
      on user_limit.discord_guild_id = target_discord_guild_id
      and user_limit.discord_user_id = target_discord_user_id
  ),
  today_usage as (
    select
      coalesce(usage.successful_questions, 0)::integer as successful_questions,
      coalesce(usage.reserved_questions, 0)::integer as reserved_questions
    from (select 1) as seed
    left join public.daily_question_usage as usage
      on usage.discord_guild_id = target_discord_guild_id
      and usage.discord_user_id = target_discord_user_id
      and usage.usage_date = (now() at time zone 'UTC')::date
  )
  select
    configured.server_daily_limit,
    configured.personal_daily_limit,
    configured.effective_daily_limit,
    today_usage.successful_questions as used,
    case
      when configured.effective_daily_limit is null then null::integer
      else greatest(
        configured.effective_daily_limit
          - today_usage.successful_questions
          - today_usage.reserved_questions,
        0
      )::integer
    end as remaining,
    coalesce(configured.effective_daily_limit = 0, false) as is_blocked
  from configured
  cross join today_usage;
$$;

create or replace function public.set_user_question_limit(
  target_discord_guild_id text,
  target_discord_user_id text,
  target_daily_limit integer,
  target_discord_moderator_user_id text
)
returns table (
  server_daily_limit integer,
  personal_daily_limit integer,
  effective_daily_limit integer,
  used integer,
  remaining integer,
  is_blocked boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if target_discord_guild_id is null or btrim(target_discord_guild_id) = ''
    or target_discord_user_id is null or btrim(target_discord_user_id) = ''
    or target_discord_moderator_user_id is null
    or btrim(target_discord_moderator_user_id) = '' then
    raise exception 'Discord guild, user, and moderator IDs are required.' using errcode = '22023';
  end if;

  if target_daily_limit is null or target_daily_limit < 0 then
    raise exception 'Personal daily limit must be zero or greater.' using errcode = '22023';
  end if;

  insert into public.user_question_limit_overrides (
    discord_guild_id,
    discord_user_id,
    daily_limit,
    updated_by_discord_user_id,
    updated_at
  )
  values (
    target_discord_guild_id,
    target_discord_user_id,
    target_daily_limit,
    target_discord_moderator_user_id,
    now()
  )
  on conflict (discord_guild_id, discord_user_id)
  do update set
    daily_limit = excluded.daily_limit,
    updated_by_discord_user_id = excluded.updated_by_discord_user_id,
    updated_at = excluded.updated_at;

  return query
  select status.*
  from public.get_user_question_limit_status(
    target_discord_guild_id,
    target_discord_user_id
  ) as status;
end;
$$;

create or replace function public.reset_user_question_limit(
  target_discord_guild_id text,
  target_discord_user_id text
)
returns table (
  server_daily_limit integer,
  personal_daily_limit integer,
  effective_daily_limit integer,
  used integer,
  remaining integer,
  is_blocked boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.user_question_limit_overrides as user_limit
  where user_limit.discord_guild_id = target_discord_guild_id
    and user_limit.discord_user_id = target_discord_user_id;

  return query
  select status.*
  from public.get_user_question_limit_status(
    target_discord_guild_id,
    target_discord_user_id
  ) as status;
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
  select user_limit.daily_limit
  into configured_limit
  from public.user_question_limit_overrides as user_limit
  where user_limit.discord_guild_id = target_discord_guild_id
    and user_limit.discord_user_id = target_discord_user_id;

  if not found then
    select guild_limit.daily_limit
    into configured_limit
    from public.guild_question_limits as guild_limit
    where guild_limit.discord_guild_id = target_discord_guild_id;
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

  if configured_limit is not null
    and (
      configured_limit = 0
      or current_usage + current_reserved >= configured_limit
    ) then
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
    case
      when configured_limit is null then null::integer
      else greatest(configured_limit - current_usage - current_reserved, 0)
    end;
end;
$$;

alter table public.user_question_limit_overrides enable row level security;

revoke all privileges on table public.user_question_limit_overrides
from public, anon, authenticated;

grant select, insert, update, delete on table public.user_question_limit_overrides
to service_role;

revoke all privileges on function public.get_user_question_limit_status(text, text)
from public, anon, authenticated;
revoke all privileges on function public.set_user_question_limit(text, text, integer, text)
from public, anon, authenticated;
revoke all privileges on function public.reset_user_question_limit(text, text)
from public, anon, authenticated;
revoke all privileges on function public.reserve_daily_question(text, text)
from public, anon, authenticated;

grant execute on function public.get_user_question_limit_status(text, text)
to service_role;
grant execute on function public.set_user_question_limit(text, text, integer, text)
to service_role;
grant execute on function public.reset_user_question_limit(text, text)
to service_role;
grant execute on function public.reserve_daily_question(text, text)
to service_role;
