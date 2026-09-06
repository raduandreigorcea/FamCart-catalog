-- ─── foundation ──────────────────────────────────────────────────────────────
-- Extensions, identity, and the admin list. Nothing about products.
--
-- This file is a RESTATEMENT, like every migration here: it describes what the
-- database should look like, not a step from one shape to another, and it is
-- written to be re-runnable. `supabase db push` tracks by filename, so editing
-- this file changes nothing on a database that already recorded it — see the
-- repair/push dance in the app repo's CLAUDE.md.

-- pg_trgm answers the prefix and the typo; unaccent is half of the folding rule.
-- Both go in `extensions` rather than `public` so a dump of the public schema is
-- the catalog and nothing else.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

grant usage on schema public to authenticated;
grant usage on schema public to anon;

-- ─── who is asking ───────────────────────────────────────────────────────────
-- Clerk mints the token; Supabase's Third-Party Auth integration validates it
-- and PostgREST puts the claims in a GUC. `sub` is the Clerk user id.
--
-- Configured in a dashboard and NOWHERE in this repo: all three Supabase
-- projects name the same Clerk issuer. That shared issuer is what lets one
-- signed-in session query the app project and this one with a single token.
-- Miss it here and reads still work while every popularity bump silently stops
-- counting.
create or replace function public.requesting_user_id()
returns text
language sql
stable
as $$
  -- nullif BEFORE the cast, not after. current_setting(..., true) returns '' for
  -- a GUC that was never set, and ''::jsonb raises rather than returning null --
  -- so an unauthenticated call would fail with "invalid input syntax for type
  -- json" instead of quietly being nobody.
  select nullif(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'),
    ''
  )
$$;

comment on function public.requesting_user_id() is
  'The Clerk user id from the verified JWT, or null when unauthenticated.';

-- ─── the admin list ──────────────────────────────────────────────────────────
-- A table rather than a claim, because the claim would have to be minted by
-- Clerk and this project is not where Clerk is configured. One row per admin.
create table if not exists public.catalog_admins (
  user_id    text primary key,
  note       text,
  granted_at timestamptz not null default now()
);

comment on table public.catalog_admins is
  'Clerk user ids allowed to read provenance, scrape runs and the admin RPCs.';

-- security definer so the check can read a table the caller cannot.
create or replace function public.catalog_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.catalog_admins a
    where a.user_id = public.requesting_user_id()
  )
$$;

comment on function public.catalog_is_admin() is
  'True when the caller is listed in catalog_admins.';

revoke all on function public.catalog_is_admin() from public, anon;
grant execute on function public.catalog_is_admin() to authenticated;

alter table public.catalog_admins enable row level security;

drop policy if exists "admins can read the admin list" on public.catalog_admins;
create policy "admins can read the admin list"
  on public.catalog_admins for select to authenticated
  using (public.catalog_is_admin());

-- No client write path anywhere in this schema. An admin is granted by a
-- service-role insert, which means by somebody with the project keys.
revoke all on public.catalog_admins from anon, authenticated;
grant select on public.catalog_admins to authenticated;
