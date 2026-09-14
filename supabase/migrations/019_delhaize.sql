-- ─── Delhaize Belgium ────────────────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. This one can:
-- src/retailers/delhaize reads its Dutch product sitemap, groceries only, and was
-- checked with the crawler's own user agent on 2026-09-14. Its own file, for the
-- reason 016 gives.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('delhaize', 'Delhaize', 'BE', 'delhaize.be')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
