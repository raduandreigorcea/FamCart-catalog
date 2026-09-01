-- Everything about a product, editable.
--
-- 009 let an admin change a product's name, type, language, brand, category,
-- markets and base weight. That left four stored columns unreachable -- the
-- barcode, the quantity pair, the image and the quality tier -- so correcting
-- any of them meant deleting the product and making it again, which throws away
-- its earned add_count and its provenance to fix a typo in a number.
--
-- THE BARCODE, WHICH 009 REFUSED ON PURPOSE
--
-- It was left out because a scan resolves through catalog_identifiers and
-- nowhere else, so moving a code silently sends every future scan of it to a
-- different product. That risk is real and it has not gone away; what has
-- changed is who decides. The answer is not to withhold the field but to make
-- the dangerous version of it impossible: a code already claimed by another
-- product is refused by name, the format is checked before the constraint can
-- fire, and clearing is distinguishable from leaving alone so that a caller
-- that simply does not mention the barcode cannot wipe one.
--
-- ONE CONVENTION FOR EVERY ARGUMENT, because the alternative is remembering
-- which fields behave which way:
--
--   null           leave this column exactly as it is
--   '' (empty)     clear it to null
--   anything else  set it
--
-- That is why the numeric and array arguments are not simply nullable: `null`
-- had to keep meaning "not mentioned" for all of them, or an update that omitted
-- a field would quietly erase it. Quantity and its unit move together, since the
-- check constraint requires both or neither, and clearing the unit clears the
-- pair.

-- The argument list is different, so this is a new function rather than a
-- replacement: `create or replace` with a different signature would leave BOTH
-- resident and PostgREST resolves by argument names, which would make the choice
-- between them depend on what the caller happened to send.
drop function if exists public.catalog_admin_update_product(
  uuid, text, text, text, text, text, text[], integer
);

create or replace function public.catalog_admin_update_product(
  p_id            uuid,
  p_name          text,
  p_type          text,
  p_lang          text,
  p_brand         text    default null,
  p_category      text    default null,
  p_markets       text[]  default null,
  p_base_weight   integer default null,
  p_barcode       text    default null,
  p_quantity      numeric default null,
  p_quantity_unit text    default null,
  p_image_url     text    default null,
  p_quality_tier  text    default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text := btrim(coalesce(p_name, ''));
  v_brand text := nullif(btrim(coalesce(p_brand, '')), '');
  v_norm  text;
  v_row   public.catalog_products%rowtype;
  v_code  text;
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  select * into v_row from public.catalog_products where id = p_id;
  if not found then
    raise exception 'That product no longer exists.'
      using errcode = 'P0001', detail = 'not_found';
  end if;

  if v_name = '' or char_length(v_name) > 120 then
    raise exception 'A product name is required and must be at most 120 characters.'
      using errcode = 'P0001', detail = 'bad_name';
  end if;

  if coalesce(p_type, '') not in ('generic', 'commercial') then
    raise exception 'A product is either generic or commercial.'
      using errcode = 'P0001', detail = 'bad_type';
  end if;

  if coalesce(p_lang, '') not in ('en', 'de', 'es', 'ro', 'fr', 'it') then
    raise exception 'The name language must be one of en, de, es, ro, fr, it.'
      using errcode = 'P0001', detail = 'bad_lang';
  end if;

  if p_markets is not null and not (p_markets <@ array['RO','MD','DE','AT','CH','ES','FR','BE','IT','GB','IE']::text[]) then
    raise exception 'One of those markets is not a market this catalog can hold.'
      using errcode = 'P0001', detail = 'bad_markets';
  end if;

  -- The seventeen the check constraint accepts. Checked here so a category the
  -- dashboard offers but the constraint refuses is a sentence rather than a
  -- constraint violation naming a table.
  if nullif(btrim(coalesce(p_category, '')), '') is not null
     and btrim(p_category) not in (
       'produce', 'dairy', 'bakery', 'meat', 'fish', 'pantry', 'frozen',
       'snacks', 'drinks', 'alcohol', 'baby', 'household', 'personal-care',
       'health', 'pet', 'home', 'other'
     ) then
    raise exception 'That is not a category this catalog uses.'
      using errcode = 'P0001', detail = 'bad_category';
  end if;

  if nullif(btrim(coalesce(p_quality_tier, '')), '') is not null
     and upper(btrim(p_quality_tier)) not in ('A', 'B', 'C') then
    raise exception 'A record tier is A, B or C.'
      using errcode = 'P0001', detail = 'bad_quality_tier';
  end if;

  -- Both or neither, and a positive number, because that is what the check
  -- constraint says and a half-filled pair is the easy mistake here.
  if nullif(btrim(coalesce(p_quantity_unit, '')), '') is not null then
    if btrim(p_quantity_unit) not in ('g', 'kg', 'ml', 'l', 'cl', 'piece') then
      raise exception 'A quantity unit is one of g, kg, ml, l, cl or piece.'
        using errcode = 'P0001', detail = 'bad_quantity_unit';
    end if;
    if p_quantity is null or p_quantity <= 0 then
      raise exception 'A quantity needs a number greater than zero to go with its unit.'
        using errcode = 'P0001', detail = 'bad_quantity';
    end if;
  end if;

  if nullif(btrim(coalesce(p_image_url, '')), '') is not null
     and (btrim(p_image_url) !~ '^https://' or char_length(btrim(p_image_url)) > 500) then
    raise exception 'An image address must start with https:// and be under 500 characters.'
      using errcode = 'P0001', detail = 'bad_image_url';
  end if;

  v_norm := public.catalog_normalize(v_name, v_brand);
  if v_norm = '' then
    raise exception 'That name does not reduce to a usable key.'
      using errcode = 'P0001', detail = 'bad_normalized_name';
  end if;

  if exists (
    select 1 from public.catalog_products
    where normalized_name = v_norm and id <> p_id
  ) then
    raise exception 'Another product already normalises to that name.'
      using errcode = 'P0001', detail = 'duplicate_name';
  end if;

  -- ─── the barcode ───────────────────────────────────────────────────────────
  -- Only touched when it was mentioned. See the header: a caller that does not
  -- send one must not be able to remove one.
  if p_barcode is not null then
    v_code := nullif(btrim(p_barcode), '');

    if v_code is null then
      -- Explicitly emptied: the product becomes unscannable, which is a real
      -- thing to want when a code turns out to belong to something else.
      delete from public.catalog_identifiers
      where product_id = p_id and identifier_type = 'gtin';
    else
      if v_code !~ '^[0-9]{8,14}$' then
        raise exception 'A barcode must be 8 to 14 digits.'
          using errcode = 'P0001', detail = 'bad_barcode';
      end if;

      -- The check that makes this safe to offer at all. Without it, one product
      -- takes another's code and every scan of it lands on the wrong thing.
      if exists (
        select 1 from public.catalog_identifiers
        where identifier_type = 'gtin'
          and identifier_value = v_code
          and product_id <> p_id
      ) then
        raise exception 'Another product already claims that barcode.'
          using errcode = 'P0001', detail = 'duplicate_barcode';
      end if;

      delete from public.catalog_identifiers
      where product_id = p_id and identifier_type = 'gtin' and identifier_value <> v_code;

      insert into public.catalog_identifiers
        (product_id, identifier_type, identifier_value, source)
      values (p_id, 'gtin', v_code, 'admin')
      on conflict (identifier_type, identifier_value) do nothing;
    end if;
  end if;

  -- add_count, source_count and the derived columns stay out of this, as in 009.
  update public.catalog_products
  set canonical_name = v_name,
      product_type   = p_type,
      name_lang      = p_lang,
      brand          = v_brand,
      category       = case
                         when p_category is null then category
                         when btrim(p_category) = '' then null
                         else btrim(p_category)
                       end,
      markets        = coalesce(p_markets, markets),
      base_weight    = greatest(coalesce(p_base_weight, base_weight), 0),
      quality_tier   = case
                         when nullif(btrim(coalesce(p_quality_tier, '')), '') is null
                           then quality_tier
                         else upper(btrim(p_quality_tier))
                       end,
      -- The pair moves together: clearing the unit clears the number with it,
      -- because the constraint refuses one without the other.
      quantity       = case
                         when p_quantity_unit is null then quantity
                         when btrim(p_quantity_unit) = '' then null
                         else p_quantity
                       end,
      quantity_unit  = case
                         when p_quantity_unit is null then quantity_unit
                         when btrim(p_quantity_unit) = '' then null
                         else btrim(p_quantity_unit)
                       end,
      image_url      = case
                         when p_image_url is null then image_url
                         when btrim(p_image_url) = '' then null
                         else btrim(p_image_url)
                       end
  where id = p_id;
end;
$$;

comment on function public.catalog_admin_update_product(uuid, text, text, text, text, text, text[], integer, text, numeric, text, text, text) is
  'Correct every editable column of a reference product, the barcode included. '
  'Admin only. null leaves a column alone, an empty string clears it. Leaves '
  'add_count, source_count and the derived columns untouched.';

revoke all on function public.catalog_admin_update_product(uuid, text, text, text, text, text, text[], integer, text, numeric, text, text, text)
  from public, anon;
grant execute on function public.catalog_admin_update_product(uuid, text, text, text, text, text, text[], integer, text, numeric, text, text, text)
  to authenticated;

-- ─── one rule for the merge key ──────────────────────────────────────────────
-- 009's create built the normalised name by concatenating the name and brand
-- itself and passing the result to the one-argument form. That happens to agree
-- with catalog_normalize(name, brand) today, because the two-argument form joins
-- them with a single space -- but it is a second copy of a rule that the
-- catalog_products_derive trigger owns, and the two would part company silently
-- the first time that join changed. The pre-check would then pass and the unique
-- index would fire, which is the raw 23505 the check exists to avoid.
create or replace function public.catalog_admin_create_product(
  p_name         text,
  p_type         text default 'generic',
  p_lang         text default 'en',
  p_brand        text default null,
  p_category     text default null,
  p_markets      text[] default '{}',
  p_barcode      text default null,
  p_base_weight  integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name    text := btrim(coalesce(p_name, ''));
  v_brand   text := nullif(btrim(coalesce(p_brand, '')), '');
  v_barcode text := nullif(btrim(coalesce(p_barcode, '')), '');
  v_norm    text;
  v_id      uuid;
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  if v_name = '' or char_length(v_name) > 120 then
    raise exception 'A product name is required and must be at most 120 characters.'
      using errcode = 'P0001', detail = 'bad_name';
  end if;

  if coalesce(p_type, '') not in ('generic', 'commercial') then
    raise exception 'A product is either generic or commercial.'
      using errcode = 'P0001', detail = 'bad_type';
  end if;

  if coalesce(p_lang, '') not in ('en', 'de', 'es', 'ro', 'fr', 'it') then
    raise exception 'The name language must be one of en, de, es, ro, fr, it.'
      using errcode = 'P0001', detail = 'bad_lang';
  end if;

  if not (coalesce(p_markets, '{}') <@ array['RO','MD','DE','AT','CH','ES','FR','BE','IT','GB','IE']::text[]) then
    raise exception 'One of those markets is not a market this catalog can hold.'
      using errcode = 'P0001', detail = 'bad_markets';
  end if;

  if nullif(btrim(coalesce(p_category, '')), '') is not null
     and btrim(p_category) not in (
       'produce', 'dairy', 'bakery', 'meat', 'fish', 'pantry', 'frozen',
       'snacks', 'drinks', 'alcohol', 'baby', 'household', 'personal-care',
       'health', 'pet', 'home', 'other'
     ) then
    raise exception 'That is not a category this catalog uses.'
      using errcode = 'P0001', detail = 'bad_category';
  end if;

  -- The trigger's own rule, called rather than reproduced.
  v_norm := public.catalog_normalize(v_name, v_brand);
  if v_norm = '' then
    raise exception 'That name does not reduce to a usable key.'
      using errcode = 'P0001', detail = 'bad_normalized_name';
  end if;

  if exists (select 1 from public.catalog_products where normalized_name = v_norm) then
    raise exception 'The catalog already holds a product that normalises to that name.'
      using errcode = 'P0001', detail = 'duplicate_name';
  end if;

  if v_barcode is not null then
    if v_barcode !~ '^[0-9]{8,14}$' then
      raise exception 'A barcode must be 8 to 14 digits.'
        using errcode = 'P0001', detail = 'bad_barcode';
    end if;

    if exists (
      select 1 from public.catalog_identifiers
      where identifier_type = 'gtin' and identifier_value = v_barcode
    ) then
      raise exception 'Another product already claims that barcode.'
        using errcode = 'P0001', detail = 'duplicate_barcode';
    end if;
  end if;

  insert into public.catalog_products
    (product_type, canonical_name, name_lang, brand, category, markets,
     base_weight, add_count, source_count)
  values
    (p_type, v_name, p_lang, v_brand,
     nullif(btrim(coalesce(p_category, '')), ''), coalesce(p_markets, '{}'),
     greatest(coalesce(p_base_weight, 0), 0), 0, 1)
  returning id into v_id;

  insert into public.catalog_sources (product_id, source_name, source_product_id)
  values (v_id, 'admin', v_id::text);

  if v_barcode is not null then
    insert into public.catalog_identifiers
      (product_id, identifier_type, identifier_value, source)
    values (v_id, 'gtin', v_barcode, 'admin');
  end if;

  return v_id;
end;
$$;

revoke all on function public.catalog_admin_create_product(text, text, text, text, text, text[], text, integer)
  from public, anon;
grant execute on function public.catalog_admin_create_product(text, text, text, text, text, text[], text, integer)
  to authenticated;
