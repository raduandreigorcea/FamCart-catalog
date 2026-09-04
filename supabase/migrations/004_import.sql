-- ─── the one writer ──────────────────────────────────────────────────────────
-- Everything that ever enters this catalog enters through this function, and it
-- is granted to service_role alone. There is no second path, no bulk COPY, no
-- client insert, and no admin shortcut that skips the matching rules.
--
-- WHAT IT GUARANTEES
--
--   * Idempotent. Import the same rows twice and the second pass inserts
--     nothing, creates no product, and changes no price. It only moves
--     last_seen_at, because that is the one thing that genuinely differs
--     between the two runs.
--   * add_count is never written. Earned popularity survives every re-import,
--     every rename and every price change. It is the only number here that came
--     from a person.
--   * A listing never renames its product. The first row to create a product
--     names it; later rows may fill BLANKS (a missing brand, image, quantity,
--     category) but may not overwrite a value that is already there. Otherwise
--     whichever retailer scraped last would decide what everything is called,
--     and the name would flap between runs.
--   * A GTIN collision is reported, never merged. Two products claiming one
--     barcode is a data error; guessing which is right is how a catalog ends up
--     telling somebody that shampoo is cat food.
--   * One bad row costs one row. Every row runs in its own exception block, so a
--     single 300-character name does not roll back the other 49 in the batch.
--
-- WHAT IT DOES NOT DO: availability. Importing says "I saw this". Deciding that
-- something is gone is 003's job, once, at the end of a run that earned it.

create or replace function public.catalog_import_listings(
  p_rows     jsonb,
  p_retailer text,
  p_run_id   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_retailer_id uuid;
  v_seen_at     timestamptz := now();
  v_row         jsonb;

  v_external_id text;
  v_name        text;
  v_brand       text;
  v_gtin        text;
  v_price       numeric;
  v_currency    text;
  v_quantity    numeric;
  v_unit        text;
  v_category    text;
  v_image_url   text;
  v_product_url text;
  v_available   boolean;

  v_product_id  uuid;
  v_listing_id  uuid;
  v_key         text;
  v_before      public.catalog_listings%rowtype;
  v_changed     boolean;

  v_inserted    integer := 0;
  v_updated     integer := 0;
  v_unchanged   integer := 0;
  v_created     integer := 0;
  v_idents      integer := 0;
  v_conflicts   integer := 0;
  v_errors      jsonb   := '[]'::jsonb;
  v_error_count integer := 0;
begin
  select id into v_retailer_id from public.catalog_retailers where slug = p_retailer;
  if v_retailer_id is null then
    raise exception 'unknown retailer: %', p_retailer
      using errcode = 'P0001', detail = 'unknown_retailer';
  end if;

  -- THE WATERMARK. Every row this call touches is stamped with the run's
  -- started_at, not with now(), so a crawl that takes ten hours does not leave
  -- its first hour looking staler than its last and get half of itself swept.
  if p_run_id is not null then
    select started_at into v_seen_at from public.catalog_scrape_runs where id = p_run_id;
    if v_seen_at is null then
      raise exception 'unknown run: %', p_run_id
        using errcode = 'P0001', detail = 'unknown_run';
    end if;
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    begin
      v_external_id := nullif(btrim(coalesce(v_row ->> 'external_id', '')), '');
      v_name        := nullif(btrim(coalesce(v_row ->> 'name', '')), '');
      v_brand       := nullif(btrim(coalesce(v_row ->> 'brand', '')), '');
      v_gtin        := nullif(btrim(coalesce(v_row ->> 'gtin', '')), '');
      v_currency    := nullif(btrim(upper(coalesce(v_row ->> 'currency', ''))), '');
      v_unit        := nullif(btrim(coalesce(v_row ->> 'unit', '')), '');
      v_category    := nullif(btrim(coalesce(v_row ->> 'category', '')), '');
      v_image_url   := nullif(btrim(coalesce(v_row ->> 'image_url', '')), '');
      v_product_url := nullif(btrim(coalesce(v_row ->> 'product_url', '')), '');
      v_price       := case when v_row ? 'price'    and jsonb_typeof(v_row -> 'price')    = 'number'
                            then (v_row ->> 'price')::numeric end;
      v_quantity    := case when v_row ? 'quantity' and jsonb_typeof(v_row -> 'quantity') = 'number'
                            then (v_row ->> 'quantity')::numeric end;
      v_available   := coalesce((v_row ->> 'available')::boolean, true);

      if v_external_id is null or v_name is null or v_product_url is null then
        raise exception 'row needs external_id, name and product_url'
          using errcode = 'P0001', detail = 'incomplete_row';
      end if;
      if v_gtin is not null and v_gtin !~ '^[0-9]{8,14}$' then
        v_gtin := null;  -- a malformed barcode is dropped, not fatal: the rest of the row is fine
      end if;
      -- A price with no currency cannot be stored (002 forbids it) and is not
      -- worth failing a row over; the retailer's currency is a scraper concern.
      if v_price is not null and v_currency is null then
        v_currency := 'RON';
      end if;

      -- ── resolve the product ────────────────────────────────────────────────
      -- Priority order, and nothing below it. See docs/adding-a-retailer.md.
      v_product_id := null;

      -- 1. GTIN. The only merge anybody should fully trust.
      if v_gtin is not null then
        select i.product_id into v_product_id
          from public.catalog_identifiers i
         where i.identifier_type = 'gtin' and i.identifier_value = v_gtin;
      end if;

      -- 2. This retailer already told us which product this listing is. A fact we
      --    recorded, not a guess -- and note it says nothing about OTHER
      --    retailers: an external_id identifies a listing, never a product.
      if v_product_id is null then
        select l.product_id into v_product_id
          from public.catalog_listings l
         where l.retailer_id = v_retailer_id and l.external_id = v_external_id;
      end if;

      -- 3. The merge key: brand, name without its size, canonical size.
      if v_product_id is null then
        v_key := public.catalog_merge_key(v_brand, v_name, v_quantity, v_unit);
        select p.id into v_product_id from public.catalog_products p where p.merge_key = v_key;
      end if;

      -- 4. Nothing matched, so this is a product the catalog has not held before.
      --    No fuzzy pass, no similarity threshold: two rows for one product is a
      --    cosmetic problem, one row for two products is corrupt data.
      if v_product_id is null then
        insert into public.catalog_products
          (canonical_name, brand, quantity, quantity_unit, category, image_url)
        values (v_name, v_brand, v_quantity, v_unit, v_category, v_image_url)
        returning id into v_product_id;
        v_created := v_created + 1;
      else
        -- Blanks may always be filled; nothing that is already set is touched.
        update public.catalog_products p
           set brand         = coalesce(p.brand, v_brand),
               quantity      = case when p.quantity is null and v_unit is not null then v_quantity else p.quantity end,
               quantity_unit = case when p.quantity is null and v_unit is not null then v_unit     else p.quantity_unit end,
               category      = coalesce(p.category, v_category),
               image_url     = coalesce(p.image_url, v_image_url)
         where p.id = v_product_id
           and (p.brand is null or p.quantity is null or p.category is null or p.image_url is null);
      end if;

      -- ── the identifier ─────────────────────────────────────────────────────
      if v_gtin is not null then
        begin
          insert into public.catalog_identifiers (product_id, identifier_type, identifier_value, source)
          values (v_product_id, 'gtin', v_gtin, p_retailer)
          on conflict (identifier_type, identifier_value) do nothing;
          if found then
            v_idents := v_idents + 1;
          else
            -- Already claimed. If it belongs to a different product, that is a
            -- collision worth counting and looking at, not a merge worth doing.
            if exists (
              select 1 from public.catalog_identifiers i
               where i.identifier_type = 'gtin' and i.identifier_value = v_gtin
                 and i.product_id <> v_product_id
            ) then
              v_conflicts := v_conflicts + 1;
            end if;
          end if;
        end;
      end if;

      -- ── the listing ────────────────────────────────────────────────────────
      select * into v_before
        from public.catalog_listings
       where retailer_id = v_retailer_id and external_id = v_external_id;

      if v_before.id is null then
        insert into public.catalog_listings (
          product_id, retailer_id, external_id, retailer_name, retailer_brand,
          retailer_category, price, currency, available, product_url, image_url,
          last_price_at, first_seen_at, last_seen_at
        ) values (
          v_product_id, v_retailer_id, v_external_id, v_name, v_brand,
          v_category, v_price, v_currency, v_available, v_product_url, v_image_url,
          case when v_price is not null then v_seen_at end, v_seen_at, v_seen_at
        );
        v_inserted := v_inserted + 1;
      else
        v_changed :=
             v_before.product_id        is distinct from v_product_id
          or v_before.retailer_name     is distinct from v_name
          or v_before.retailer_brand    is distinct from v_brand
          or v_before.retailer_category is distinct from v_category
          or v_before.price             is distinct from v_price
          or v_before.currency          is distinct from v_currency
          or v_before.available         is distinct from v_available
          or v_before.product_url       is distinct from v_product_url
          or v_before.image_url         is distinct from v_image_url;

        update public.catalog_listings l
           set product_id        = v_product_id,
               retailer_name     = v_name,
               retailer_brand    = v_brand,
               retailer_category = v_category,
               price             = v_price,
               currency          = v_currency,
               available         = v_available,
               product_url       = v_product_url,
               image_url         = v_image_url,
               -- previous_price only moves when the price actually moved, so it
               -- keeps meaning "what it cost before this change" rather than
               -- "what it cost during the previous run".
               previous_price    = case when v_price is distinct from l.price then l.price else l.previous_price end,
               last_price_at     = case when v_price is distinct from l.price then v_seen_at else l.last_price_at end,
               last_seen_at      = v_seen_at
         where l.id = v_before.id
        returning l.id into v_listing_id;

        if v_changed then v_updated := v_updated + 1; else v_unchanged := v_unchanged + 1; end if;
      end if;

    exception when others then
      v_error_count := v_error_count + 1;
      if jsonb_array_length(v_errors) < 25 then
        v_errors := v_errors || jsonb_build_object(
          'external_id', v_external_id,
          'name', left(coalesce(v_name, ''), 80),
          'error', sqlerrm,
          'detail', sqlstate
        );
      end if;
    end;
  end loop;

  if p_run_id is not null then
    update public.catalog_scrape_runs
       set inserted          = inserted + v_inserted,
           updated           = updated + v_updated,
           unchanged         = unchanged + v_unchanged,
           products_created  = products_created + v_created,
           identifiers_added = identifiers_added + v_idents,
           conflicts         = conflicts + v_conflicts
     where id = p_run_id;
  end if;

  return jsonb_build_object(
    'retailer', p_retailer,
    'inserted', v_inserted,
    'updated', v_updated,
    'unchanged', v_unchanged,
    'products_created', v_created,
    'identifiers_added', v_idents,
    'conflicts', v_conflicts,
    'error_count', v_error_count,
    'errors', v_errors
  );
end;
$fn$;

comment on function public.catalog_import_listings(jsonb, text, uuid) is
  'The only write path into the catalog. Idempotent, per-row isolated, never writes add_count, never decides availability.';

revoke all on function public.catalog_import_listings(jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.catalog_import_listings(jsonb, text, uuid) to service_role;
