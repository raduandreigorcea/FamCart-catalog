-- ─── foundation ──────────────────────────────────────────────────────────────
-- The primitives the rest of the catalog schema assumes exist.
--
-- These files describe the catalog schema as it IS, not the order in which it
-- was discovered — the same convention the app database uses at the repo root,
-- and for the same reason: every file is safe to re-run, so a schema drift is
-- repaired by running the file again rather than by writing a fix-up migration.
--
--   001 foundation   extensions, the JWT helper, who counts as an admin
--   002 products     the catalog itself: products, aliases, identifiers, sources
--
-- THE ONE TRAP that convention carries over with it: anything declared inside a
-- `create table if not exists` block is skipped on every database the file has
-- already run against. A bound changed there reaches new databases only. Restate
-- it below the table as `alter table ... drop constraint if exists` + `add
-- constraint`, which is what 002 does for every check it cares about.
--
-- WHAT THIS PROJECT IS. A reference catalog of products, shared live by the
-- production app and by development, holding rows that belong to nobody. It is
-- deliberately not the app database:
--
--   * no household_id, no per-household scoping, no RLS beyond "signed in may
--     read". A row here is a fact about a product, not about a person.
--   * the app database keeps its own product_catalog for rows a household
--     contributed through add_custom_product(). One product can exist in both,
--     and src/lib/productSuggestions.ts searches both and dedupes on the name.
--
-- The line is drawn there so the app's promotion rule — three households asking
-- for the same thing collapses their scoped rows into one global row — stays a
-- single transaction inside a single database. Moving global rows here would
-- have turned it into a cross-project job needing its own scheduler.

-- pg_trgm drives the substring match behind autocomplete; unaccent lets the
-- server fold names itself, which it must — a client-supplied matching key
-- becomes everyone's matching key the moment a discovered product is saved.
-- Both land in `extensions` rather than `public` so the schema stays
-- application-owned, matching the app project.
create extension if not exists pg_trgm  with schema extensions;
create extension if not exists unaccent with schema extensions;

-- ─── who is asking ───────────────────────────────────────────────────────────
-- Authentication is Clerk's, and this project sees only the verified session
-- token Clerk issued, accepted through Supabase's Third-Party Auth integration.
-- That integration is configured in the Supabase dashboard and is referenced
-- nowhere in this repository; all three FamCart projects name the same
-- `needed-bass-4.clerk.accounts.dev` issuer, which is what lets one signed-in
-- session query the app database and this one with a single token.
--
-- Every policy and RPC here identifies the caller through this function, so
-- there is one definition of "you". Returns null when unauthenticated, which is
-- what makes the policies fail closed: `= requesting_user_id()` is never true
-- for null.
--
-- Byte-identical to the app project's copy on purpose. It is duplicated rather
-- than shared because the two projects are separate databases; if one ever has
-- to change, the other almost certainly has to change with it.
create or replace function public.requesting_user_id()
returns text
language sql
stable
as $$
  select nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    ''
  )::text;
$$;

-- ─── schema access ───────────────────────────────────────────────────────────
-- Hosted Supabase grants table privileges to the API roles when a project is
-- provisioned, so the deployed project works without this. A database built from
-- migrations alone (`supabase --workdir catalog db reset`, `test db`, CI) has no
-- such grants, and every RLS policy subquery fails with "permission denied"
-- before row-level evaluation even starts.
--
-- Grants and RLS are separate gates. This opens the first; each table opens the
-- second, and RLS stays the authority on which rows are visible.
grant usage on schema public to authenticated;
grant usage on schema public to anon;

-- ─── admins ──────────────────────────────────────────────────────────────────
-- Clerk user ids allowed to see and change catalog internals from the admin
-- dashboard. This is the one table that survived the previous catalog project
-- being wiped, so the create is a no-op on the deployed project and the grants
-- and policy below are what actually run there.
--
-- Membership is granted out of band, with the service-role key. There is
-- deliberately no RPC to grant it: an admin table a client can write to is not
-- an admin table.
create table if not exists public.catalog_admins (
  user_id    text        primary key,
  note       text,
  granted_at timestamptz not null default now()
);

comment on table public.catalog_admins is
  'Clerk user ids allowed to read catalog internals and record review verdicts. Granted out of band with the service-role key.';

alter table public.catalog_admins enable row level security;

-- Is the caller an admin of THIS project?
--
-- SECURITY DEFINER breaks the policy recursion above: without it, selecting from
-- catalog_admins to decide who may select from catalog_admins re-enters the
-- policy forever. The definer body sees the table directly; the policy above it
-- still decides what a client can read.
--
-- The admin dashboard calls this by name (admin/src/lib/data/products.ts), so
-- the name and the zero-argument shape are a contract, not an implementation
-- detail.
create or replace function public.catalog_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.catalog_admins ca
    where ca.user_id = public.requesting_user_id()
  );
$$;

revoke all on function public.catalog_is_admin() from public, anon;
grant execute on function public.catalog_is_admin() to authenticated;

-- Readable only by admins, so the list of admins is not itself a public fact.
-- Recursion is not a risk here the way it is on the app's household_members:
-- this policy subqueries the same table, so it must go through a SECURITY
-- DEFINER helper. catalog_is_admin() above is that helper.
drop policy if exists "admins can read the admin list" on public.catalog_admins;
create policy "admins can read the admin list"
  on public.catalog_admins
  for select
  to authenticated
  using (public.catalog_is_admin());

revoke all on public.catalog_admins from anon, authenticated;
grant select on public.catalog_admins to authenticated;
