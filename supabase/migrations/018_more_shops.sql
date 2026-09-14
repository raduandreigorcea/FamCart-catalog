-- ─── Carrefour Italia, MPreis ────────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. These two can, each
-- with a scraper of its own (src/retailers/carrefour-it, mpreis), both checked on
-- the live sites on 2026-09-14, both reading groceries only. Dia Spain has no row:
-- it refuses this crawler (see its note in core/registry.ts).
--
-- Carrefour Italia is `carrefour-it`: the same chain as `carrefour` in Romania on
-- a different site, and the app shows it as Carrefour.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('carrefour-it', 'Carrefour', 'IT', 'carrefour.it'),
  ('mpreis',       'MPreis',    'AT', 'mpreis.at')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
