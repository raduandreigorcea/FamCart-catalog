-- ─── the images go ───────────────────────────────────────────────────────────
-- Nothing read them. The app never did: `search_catalog` does not return the
-- column and never has, so every product picture in FamCart comes from the
-- household's own data. The admin dashboard did -- a thumbnail in the command
-- palette, a URL field in the product form, a "has an image" filter -- and that
-- was the whole audience: a picture nobody outside the dashboard could see,
-- scraped from eleven sites, validated by two check constraints, carried through
-- the importer and stored on 65,034 products and 66,588 listings.
--
-- WHY THIS FILE EXISTS AT ALL, when 002, 004, 006 and 013 are edited in place
-- like every other change here. Those files are a restatement of the schema as
-- it IS, and a restatement cannot remove anything: `create table if not exists`
-- is skipped on a database that already has the table, so the column would go on
-- existing in production forever while disappearing from every fresh database.
-- The same reason 000 is a real increment rather than a restatement. A removal
-- needs a statement that says remove.
--
-- WHAT THIS COSTS IF IT WAS WRONG: the URLs. They are not recoverable from
-- anything we hold; they come back only by re-scraping every shop, which for
-- Carrefour alone is days. The scrapers no longer parse them either, so that
-- would be a revert, not a re-run.
--
-- NOT A SPACE SAVING, and it should not be sold as one. `drop column` does not
-- rewrite the heap: the bytes sit in the existing rows until something updates
-- them, and only VACUUM FULL returns them to the disk. About 14 MB, eventually,
-- as the nightly imports rewrite the rows anyway.

-- The old signatures go FIRST, and by their full argument list. PostgREST
-- resolves an RPC by the argument names in the request body, and a function
-- whose arguments all have defaults does not replace an older one with a
-- different list -- it OVERLOADS it. Leave the old one in place and every call
-- from the dashboard gets 300 Multiple Choices, which is the silent-break case
-- this repository keeps warning about. 006 and 013 above create the new ones.
drop function if exists public.catalog_admin_create_product(text, text, text, numeric, text, text, text);
drop function if exists public.catalog_admin_update_product(uuid, text, text, text, numeric, text, text, text);
drop function if exists public.catalog_admin_products(
  text, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean,
  timestamptz, integer, integer
);

alter table public.catalog_products  drop column if exists image_url;
alter table public.catalog_listings  drop column if exists image_url;
