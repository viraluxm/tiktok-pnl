-- 117_mapping_section_sides.sql
--
-- A section belongs to a SHELF, and carries which side(s) it is picked from.
--
-- WHY: 116 made sections per shelf FACE — side A and side B each had their own independent
-- list. That is expressible, but it models the rack wrongly and it reads wrongly: adding one
-- section looked like it created a front and a back, because the UI had to present every
-- rack as two permanent parallel layouts.
--
-- A section is ONE physical space. Which aisle you reach it from is a property OF that
-- space, not a separate axis the rack is divided along. So:
--
--   * `section_index` is now unique per (rack, shelf) — one list per shelf, not one per face.
--   * `side` describes reachability: 'A', 'B', or 'AB' for a section picked from both aisles.
--
-- Asymmetric racks still work exactly as before: a shelf can carry four 'A' sections and six
-- 'B' sections. The difference is that they are one list you can see at once, and "picked
-- from both sides" is an explicit per-section choice rather than a coincidence of the same
-- SKU appearing twice.
--
-- ROUTING: an 'AB' section is reachable from either aisle, so a pick line lands at whichever
-- of that rack's two stops comes first in the walking order. deriveRoute is unchanged — it
-- orders rack-SIDES; only the slot→stop lookup takes a minimum.
--
-- DATA: the single existing slot (R1, shelf 4, section 1, side A) is untouched and valid
-- under both the old and new constraints.
--
-- APPLY GATE — Class A by lock footprint. It rewrites two constraints on pick_slots, which
-- takes ACCESS EXCLUSIVE on that table; safe only because pick_slots is new, holds one row,
-- and nothing deployed reads it. Own transaction, SET LOCAL lock_timeout = '3s'.

-- Section numbers are now allocated per shelf, so the old per-face uniqueness is wrong: it
-- would allow S1 on side A and a different S1 on side B of the same shelf.
alter table public.pick_slots
  drop constraint if exists pick_slots_rack_id_shelf_index_section_index_side_key;

alter table public.pick_slots
  add constraint pick_slots_rack_shelf_section_key
  unique (rack_id, shelf_index, section_index);

-- 'AB' = one physical space reachable from both aisles.
alter table public.pick_slots
  drop constraint if exists pick_slots_side_ck;

alter table public.pick_slots
  add constraint pick_slots_side_ck check (side in ('A', 'B', 'AB'));
