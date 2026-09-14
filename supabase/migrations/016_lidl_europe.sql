-- ─── Lidl, outside Romania ───────────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE, and these nine can:
-- every Lidl country runs the same site as lidl.ro, publishes the same schema.org
-- Product block and the same numeric shelf path, and one scraper reads them all
-- (src/retailers/lidl, LIDL_COUNTRIES). Checked on the live sites on 2026-09-14.
--
-- The Romanian shop keeps the slug `lidl`. Renaming it `lidl-ro` for symmetry
-- would orphan every listing already keyed on it.
--
-- Only groceries are imported. Lidl's German, French, Belgian and Spanish sites
-- are mostly an online shop for furniture, tools and clothes; the scraper keeps
-- shelf 0/17 (food and near-food) and 0/10 (drinks) and nothing else.
--
-- Its own file rather than an edit to 011: 011 is applied everywhere, so an edit
-- there would reach a fresh database and nothing else.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('lidl-it', 'Lidl', 'IT', 'lidl.it'),
  ('lidl-de', 'Lidl', 'DE', 'lidl.de'),
  ('lidl-at', 'Lidl', 'AT', 'lidl.at'),
  ('lidl-ch', 'Lidl', 'CH', 'lidl.ch'),
  ('lidl-es', 'Lidl', 'ES', 'lidl.es'),
  ('lidl-fr', 'Lidl', 'FR', 'lidl.fr'),
  ('lidl-be', 'Lidl', 'BE', 'lidl.be'),
  ('lidl-gb', 'Lidl', 'GB', 'lidl.co.uk'),
  ('lidl-ie', 'Lidl', 'IE', 'lidl.ie')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
