create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  slug text not null unique,
  display_name text not null default '',
  bio text not null default '',
  avatar_url text not null default '',
  role text not null default 'user',
  status text not null default 'active',
  plan text not null default 'free',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists email text not null default '';
alter table public.profiles add column if not exists role text not null default 'user';
alter table public.profiles add column if not exists status text not null default 'active';
alter table public.profiles add column if not exists plan text not null default 'free';

create table if not exists public.links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  url text not null,
  tag text not null default '',
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  link_id uuid references public.links(id) on delete set null,
  event_type text not null,
  source_slug text not null default '',
  referrer text not null default '',
  user_agent text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists links_user_id_position_idx on public.links (user_id, position);
create index if not exists analytics_events_owner_idx on public.analytics_events (owner_user_id, created_at desc);
create index if not exists analytics_events_link_idx on public.analytics_events (link_id, created_at desc);

-- Constraints (guarded so script can be rerun)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_slug_format'
  ) then
    alter table public.profiles
      add constraint profiles_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'profiles_role_check'
  ) then
    alter table public.profiles
      add constraint profiles_role_check check (role in ('user', 'master_admin'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'profiles_status_check'
  ) then
    alter table public.profiles
      add constraint profiles_status_check check (status in ('active', 'suspended'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'profiles_plan_check'
  ) then
    alter table public.profiles
      add constraint profiles_plan_check check (plan in ('free', 'starter', 'pro', 'premium'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'analytics_events_type_check'
  ) then
    alter table public.analytics_events
      add constraint analytics_events_type_check check (event_type in ('view', 'click'));
  end if;
end
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.is_master_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.user_id = (select auth.uid())
      and p.role = 'master_admin'
      and p.status = 'active'
  );
$$;

create or replace function public.protect_profile_sensitive_fields()
returns trigger
language plpgsql
as $$
begin
  if (select auth.uid()) = old.user_id and not (select public.is_master_admin()) then
    if old.role is distinct from new.role then
      raise exception 'Nije dozvoljena promena role';
    end if;

    if old.status is distinct from new.status then
      raise exception 'Nije dozvoljena promena statusa';
    end if;

    if old.plan is distinct from new.plan then
      raise exception 'Nije dozvoljena promena plana';
    end if;

    if old.email is distinct from new.email then
      raise exception 'Nije dozvoljena promena email adrese';
    end if;
  end if;

  return new;
end;
$$;

grant execute on function public.is_master_admin() to anon, authenticated;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row
execute procedure public.touch_updated_at();

drop trigger if exists trg_profiles_protect_sensitive on public.profiles;
create trigger trg_profiles_protect_sensitive
before update on public.profiles
for each row
execute procedure public.protect_profile_sensitive_fields();

drop trigger if exists trg_links_updated_at on public.links;
create trigger trg_links_updated_at
before update on public.links
for each row
execute procedure public.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.links enable row level security;
alter table public.analytics_events enable row level security;

-- Profiles policies
drop policy if exists "Profiles select access" on public.profiles;
create policy "Profiles select access"
on public.profiles
for select
using (
  status = 'active'
  or (select auth.uid()) = user_id
  or (select public.is_master_admin())
);

drop policy if exists "Profiles insert own" on public.profiles;
create policy "Profiles insert own"
on public.profiles
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Profiles update own or master" on public.profiles;
create policy "Profiles update own or master"
on public.profiles
for update
to authenticated
using ((select auth.uid()) = user_id or (select public.is_master_admin()))
with check ((select auth.uid()) = user_id or (select public.is_master_admin()));

drop policy if exists "Profiles delete own or master" on public.profiles;
create policy "Profiles delete own or master"
on public.profiles
for delete
to authenticated
using ((select auth.uid()) = user_id or (select public.is_master_admin()));

-- Links policies
drop policy if exists "Links public select active profiles" on public.links;
create policy "Links public select active profiles"
on public.links
for select
using (
  exists (
    select 1
    from public.profiles p
    where p.user_id = links.user_id
      and p.status = 'active'
  )
);

drop policy if exists "Links insert own or master" on public.links;
create policy "Links insert own or master"
on public.links
for insert
to authenticated
with check ((select auth.uid()) = user_id or (select public.is_master_admin()));

drop policy if exists "Links update own or master" on public.links;
create policy "Links update own or master"
on public.links
for update
to authenticated
using ((select auth.uid()) = user_id or (select public.is_master_admin()))
with check ((select auth.uid()) = user_id or (select public.is_master_admin()));

drop policy if exists "Links delete own or master" on public.links;
create policy "Links delete own or master"
on public.links
for delete
to authenticated
using ((select auth.uid()) = user_id or (select public.is_master_admin()));

-- Analytics policies
drop policy if exists "Analytics select own or master" on public.analytics_events;
create policy "Analytics select own or master"
on public.analytics_events
for select
to authenticated
using ((select auth.uid()) = owner_user_id or (select public.is_master_admin()));

drop policy if exists "Analytics insert public" on public.analytics_events;
create policy "Analytics insert public"
on public.analytics_events
for insert
to anon, authenticated
with check (
  event_type in ('view', 'click')
  and exists (
    select 1
    from public.profiles p
    where p.user_id = owner_user_id
      and p.status = 'active'
  )
);

drop policy if exists "Analytics delete own or master" on public.analytics_events;
create policy "Analytics delete own or master"
on public.analytics_events
for delete
to authenticated
using ((select auth.uid()) = owner_user_id or (select public.is_master_admin()));
