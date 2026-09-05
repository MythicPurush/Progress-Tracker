-- Progress Tracker cloud schema
-- Run this once in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null,
  sharing_level text not null default 'full' check (sharing_level in ('full', 'totals')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  name_norm text generated always as (lower(trim(name))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name_norm)
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  started timestamptz not null,
  seconds integer not null check (seconds > 0),
  subject text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('pending', 'accepted', 'rejected', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);

create index if not exists idx_profiles_email on public.profiles(email);
create index if not exists idx_profiles_name on public.profiles(lower(display_name));
create index if not exists idx_subjects_user on public.subjects(user_id);
create index if not exists idx_sessions_user_started on public.sessions(user_id, started);
create index if not exists idx_friendships_requester_status on public.friendships(requester_id, status);
create index if not exists idx_friendships_addressee_status on public.friendships(addressee_id, status);

-- Keep the public profile row synchronized with Supabase Auth.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do update
    set email = excluded.email,
        display_name = excluded.display_name,
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.handle_user_email_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set email = lower(new.email), updated_at = now()
  where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
after update of email on auth.users
for each row execute function public.handle_user_email_update();

-- A safe RPC for totals-only friends. It never exposes individual sessions.
create or replace function public.friend_totals(friend_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  viewer uuid := (select auth.uid());
  allowed boolean;
  total_seconds bigint;
  today_seconds bigint;
  last7_seconds bigint;
  active_days bigint;
  sessions_count bigint;
  subject_totals jsonb;
begin
  if viewer is null then
    raise exception 'Unauthorized';
  end if;

  select exists (
    select 1
    from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = viewer and f.addressee_id = friend_id)
        or (f.requester_id = friend_id and f.addressee_id = viewer))
  ) into allowed;

  if not allowed then
    raise exception 'You can only view accepted friends.';
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = friend_id and p.sharing_level = 'totals'
  ) then
    raise exception 'Friend is not using totals-only sharing.';
  end if;

  select coalesce(sum(s.seconds), 0), count(*)
  into total_seconds, sessions_count
  from public.sessions s
  where s.user_id = friend_id;

  select coalesce(sum(s.seconds), 0)
  into today_seconds
  from public.sessions s
  where s.user_id = friend_id
    and s.started >= date_trunc('day', now())
    and s.started < date_trunc('day', now()) + interval '1 day';

  select coalesce(sum(s.seconds), 0)
  into last7_seconds
  from public.sessions s
  where s.user_id = friend_id
    and s.started >= now() - interval '7 days';

  select count(distinct (s.started at time zone 'UTC')::date)
  into active_days
  from public.sessions s
  where s.user_id = friend_id;

  select coalesce(jsonb_agg(jsonb_build_array(subject, seconds) order by seconds desc), '[]'::jsonb)
  into subject_totals
  from (
    select s.subject, sum(s.seconds)::bigint as seconds
    from public.sessions s
    where s.user_id = friend_id
    group by s.subject
  ) x;

  return jsonb_build_object(
    'totalSeconds', total_seconds,
    'todaySeconds', today_seconds,
    'last7DaysSeconds', last7_seconds,
    'activeDays', active_days,
    'sessionsCount', sessions_count,
    'subjectTotals', subject_totals
  );
end;
$$;

revoke execute on function public.friend_totals(uuid) from public;
grant execute on function public.friend_totals(uuid) to authenticated;

-- RLS
alter table public.profiles enable row level security;
alter table public.subjects enable row level security;
alter table public.sessions enable row level security;
alter table public.friendships enable row level security;

grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.subjects to authenticated;
grant select, insert, update, delete on public.sessions to authenticated;
grant select, insert, update, delete on public.friendships to authenticated;

-- Profiles are searchable by signed-in users so the friend picker can find people.
drop policy if exists profiles_select_authenticated on public.profiles;
create policy profiles_select_authenticated
on public.profiles for select to authenticated
using (true);

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self
on public.profiles for insert to authenticated
with check ((select auth.uid()) = id);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
on public.profiles for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

-- Subjects belong to their owner only. Friend views read sessions directly.
drop policy if exists subjects_owner_all on public.subjects;
create policy subjects_owner_all
on public.subjects for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Sessions: owner always has full access. Accepted friends can read only when the
-- owner chose full sharing. Totals-only friends are served through friend_totals().
drop policy if exists sessions_select_owner_or_full_friend on public.sessions;
create policy sessions_select_owner_or_full_friend
on public.sessions for select to authenticated
using (
  (select auth.uid()) = user_id
  or exists (
    select 1
    from public.friendships f
    join public.profiles p on p.id = user_id
    where f.status = 'accepted'
      and p.sharing_level = 'full'
      and ((f.requester_id = (select auth.uid()) and f.addressee_id = user_id)
        or (f.addressee_id = (select auth.uid()) and f.requester_id = user_id))
  )
);

drop policy if exists sessions_insert_owner on public.sessions;
create policy sessions_insert_owner
on public.sessions for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists sessions_update_owner on public.sessions;
create policy sessions_update_owner
on public.sessions for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists sessions_delete_owner on public.sessions;
create policy sessions_delete_owner
on public.sessions for delete to authenticated
using ((select auth.uid()) = user_id);

-- Friendships are visible to participants. Only the requester may create a request;
-- only the addressee may change a pending request to accepted/rejected/blocked.
drop policy if exists friendships_select_participant on public.friendships;
create policy friendships_select_participant
on public.friendships for select to authenticated
using ((select auth.uid()) = requester_id or (select auth.uid()) = addressee_id);

drop policy if exists friendships_insert_requester on public.friendships;
create policy friendships_insert_requester
on public.friendships for insert to authenticated
with check ((select auth.uid()) = requester_id and requester_id <> addressee_id);

drop policy if exists friendships_update_participant on public.friendships;
create policy friendships_update_participant
on public.friendships for update to authenticated
using ((select auth.uid()) = requester_id or (select auth.uid()) = addressee_id)
with check ((select auth.uid()) = requester_id or (select auth.uid()) = addressee_id);

drop policy if exists friendships_delete_participant on public.friendships;
create policy friendships_delete_participant
on public.friendships for delete to authenticated
using ((select auth.uid()) = requester_id or (select auth.uid()) = addressee_id);

-- Do not expose auth.users through the Data API; the app uses public.profiles.
