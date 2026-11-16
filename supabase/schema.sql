-- VitalPath Health Journal — Supabase schema
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste this whole file → Run.
-- Safe to re-run: every statement checks before creating.
--
-- Every table carries user_id and Row Level Security, so each signed-in person
-- can read and change only their own rows. Report photos live in the private
-- "reports" storage bucket under a folder named after the user's id.

-- ───────────────────────── Tables ─────────────────────────

create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  name          text not null,
  age           int  check (age between 1 and 120),
  sex           text,
  height_cm     numeric check (height_cm between 50 and 250),
  weight_kg     numeric check (weight_kg between 10 and 400),
  condition     text,
  bp_target     text,
  sugar_target  text,
  contacts      jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

create table if not exists public.bp_readings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  taken_at    timestamptz not null,
  systolic    int not null check (systolic between 40 and 300),
  diastolic   int not null check (diastolic between 20 and 200),
  pulse       int check (pulse between 20 and 250),
  position    text,
  context     text,
  note        text,
  created_at  timestamptz not null default now()
);

create table if not exists public.glucose_readings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  taken_at      timestamptz not null,
  value         numeric not null check (value > 0),
  unit          text not null check (unit in ('mg/dL','mmol/L','% (HbA1c)')),
  measure_type  text not null,
  note          text,
  created_at    timestamptz not null default now()
);

create table if not exists public.medical_history (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_at    timestamptz not null,
  event_type  text not null,
  doctor      text,
  facility    text,
  reason      text not null,
  outcome     text,
  notes       text,
  created_at  timestamptz not null default now()
);

create table if not exists public.lab_reports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  report_date  date not null,
  lab_name     text,
  doctor       text,
  notes        text,
  created_at   timestamptz not null default now()
);

create table if not exists public.lab_results (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  report_id   uuid not null references public.lab_reports(id) on delete cascade,
  panel       text not null,
  test_code   text not null,
  test_name   text not null,
  value       numeric not null,
  unit        text,
  ref_low     numeric,
  ref_high    numeric,
  sort_order  int not null default 0
);

create table if not exists public.report_files (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  report_id   uuid not null references public.lab_reports(id) on delete cascade,
  path        text not null unique,
  file_name   text,
  mime        text,
  size_bytes  int,
  created_at  timestamptz not null default now()
);

create table if not exists public.share_links (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  token         text not null unique check (length(token) >= 32),
  period_label  text not null,
  from_at       timestamptz not null,
  to_at         timestamptz not null,
  from_date     date not null,
  to_date       date not null,
  expires_at    timestamptz not null,
  revoked       boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists bp_user_time      on public.bp_readings      (user_id, taken_at);
create index if not exists glucose_user_time on public.glucose_readings (user_id, taken_at);
create index if not exists medical_user_time on public.medical_history  (user_id, event_at);
create index if not exists reports_user_date on public.lab_reports      (user_id, report_date);
create index if not exists results_report    on public.lab_results      (report_id);
create index if not exists files_report      on public.report_files     (report_id);

-- ───────────────────────── Table access ─────────────────────────
-- Signed-in users reach the tables through the Data API; RLS below limits them to their own rows.
-- Anonymous visitors get no table access at all — share links go through get_shared_report only.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.profiles, public.bp_readings, public.glucose_readings, public.medical_history,
  public.lab_reports, public.lab_results, public.report_files, public.share_links
  to authenticated;
revoke all on
  public.profiles, public.bp_readings, public.glucose_readings, public.medical_history,
  public.lab_reports, public.lab_results, public.report_files, public.share_links
  from anon;

-- ───────────────────────── Row Level Security ─────────────────────────

alter table public.profiles          enable row level security;
alter table public.bp_readings       enable row level security;
alter table public.glucose_readings  enable row level security;
alter table public.medical_history   enable row level security;
alter table public.lab_reports       enable row level security;
alter table public.lab_results       enable row level security;
alter table public.report_files      enable row level security;
alter table public.share_links       enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

do $$
declare t text;
begin
  foreach t in array array['bp_readings','glucose_readings','medical_history','lab_reports','share_links'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all to authenticated
                    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- Results and files must also point at a report the same person owns.
drop policy if exists "own rows" on public.lab_results;
create policy "own rows" on public.lab_results for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.lab_reports r where r.id = report_id and r.user_id = (select auth.uid())));

drop policy if exists "own rows" on public.report_files;
create policy "own rows" on public.report_files for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and split_part(path, '/', 1) = (select auth.uid())::text
    and exists (select 1 from public.lab_reports r where r.id = report_id and r.user_id = (select auth.uid())));

-- ───────────────────────── Report photo storage ─────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('reports', 'reports', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "reports: read own"   on storage.objects;
drop policy if exists "reports: add own"    on storage.objects;
drop policy if exists "reports: change own" on storage.objects;
drop policy if exists "reports: delete own" on storage.objects;

create policy "reports: read own" on storage.objects for select to authenticated
  using (bucket_id = 'reports' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "reports: add own" on storage.objects for insert to authenticated
  with check (bucket_id = 'reports' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "reports: change own" on storage.objects for update to authenticated
  using (bucket_id = 'reports' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "reports: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'reports' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ───────────────────────── Read-only share links ─────────────────────────
-- Anyone holding an unexpired, unrevoked token can read that one period of that
-- one person's records — and nothing else. Contacts and photos are not included.

create or replace function public.get_shared_report(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare s public.share_links;
begin
  select * into s from public.share_links
   where token = p_token and not revoked and expires_at > now();
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'period', jsonb_build_object('label', s.period_label, 'fromAt', s.from_at, 'toAt', s.to_at,
                                 'fromDate', s.from_date, 'toDate', s.to_date, 'expiresAt', s.expires_at),
    'profile', (select jsonb_build_object('name', p.name, 'age', p.age, 'sex', p.sex, 'condition', p.condition)
                  from public.profiles p where p.id = s.user_id),
    'bp', coalesce((select jsonb_agg(to_jsonb(b) - 'user_id' order by b.taken_at)
                      from public.bp_readings b
                     where b.user_id = s.user_id and b.taken_at >= s.from_at and b.taken_at < s.to_at), '[]'::jsonb),
    'glucose', coalesce((select jsonb_agg(to_jsonb(g) - 'user_id' order by g.taken_at)
                           from public.glucose_readings g
                          where g.user_id = s.user_id and g.taken_at >= s.from_at and g.taken_at < s.to_at), '[]'::jsonb),
    'medical', coalesce((select jsonb_agg(to_jsonb(m) - 'user_id' order by m.event_at)
                           from public.medical_history m
                          where m.user_id = s.user_id and m.event_at >= s.from_at and m.event_at < s.to_at), '[]'::jsonb),
    'reports', coalesce((select jsonb_agg(
                           (to_jsonb(r) - 'user_id') || jsonb_build_object(
                             'results', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id' order by x.sort_order)
                                                    from public.lab_results x where x.report_id = r.id), '[]'::jsonb),
                             'file_count', (select count(*) from public.report_files f where f.report_id = r.id))
                           order by r.report_date)
                           from public.lab_reports r
                          where r.user_id = s.user_id and r.report_date between s.from_date and s.to_date), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_shared_report(text) from public;
grant execute on function public.get_shared_report(text) to anon, authenticated;
