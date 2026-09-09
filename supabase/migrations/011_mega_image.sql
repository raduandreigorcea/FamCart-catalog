-- ─── Mega Image gets a row ───────────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. That is why
-- Kaufland has never had one and why Mega Image did not either, for as long as
-- it sat in the registry as unreadable.
--
-- It is readable, and the note saying otherwise had simply gone out of date: the
-- product pages publish a price after all, nested one level down in a
-- priceSpecification, and they weigh 235 KB rather than the 730 KB the note
-- claimed. 8,879 products at one request a second is about two and a half hours
-- and two gigabytes, which is the same order as Carrefour and affordable nightly.
--
-- Not inserted into 002 alongside the other three. 002 is already applied
-- everywhere, so an edit there would reach a fresh database and nothing else --
-- the same trap that reverted catalog_run_open between 003 and 007. A new shop
-- is a new file.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('mega-image', 'Mega Image', 'RO', 'mega-image.ro')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
