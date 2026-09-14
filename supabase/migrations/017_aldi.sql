-- ─── Aldi Süd's platform, in six countries ───────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. These six can:
-- Aldi Süd, Hofer, Aldi Suisse, Aldi Italia, Aldi UK and Aldi Ireland run one
-- site, and src/retailers/aldi reads all of them (ALDI_COUNTRIES). Checked on the
-- live sites on 2026-09-14.
--
-- Austria's Aldi trades as Hofer and is `hofer`, not `aldi-at`: the slug is what
-- a person sees when a shop has no display name written down in the app.
--
-- Only groceries are imported, by each country's own list of grocery shelves.
-- Its own file, for the reason 016 gives.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('aldi-de', 'Aldi Süd',    'DE', 'aldi-sued.de'),
  ('hofer',   'Hofer',       'AT', 'hofer.at'),
  ('aldi-ch', 'Aldi Suisse', 'CH', 'aldi-suisse.ch'),
  ('aldi-it', 'Aldi',        'IT', 'aldi.it'),
  ('aldi-gb', 'Aldi',        'GB', 'aldi.co.uk'),
  ('aldi-ie', 'Aldi',        'IE', 'aldi.ie')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
