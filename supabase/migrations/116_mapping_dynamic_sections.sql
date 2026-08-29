-- 116_mapping_dynamic_sections.sql
--
-- Sections become fully dynamic, per (shelf, side).
--
-- WHY: 115 modelled a rack as a uniform grid — one `sections_per_shelf` for the whole rack,
-- so every shelf and both faces were forced to the same width. Real racks are not uniform:
-- one side may hold 4 sections while the other holds 6, and one shelf may be divided
-- differently from the shelf above it. A rack-level count cannot express that.
--
-- No new structure is needed to fix it. pick_slots already stores (shelf_index,
-- section_index, side) per row, so "how many sections does shelf 2 side B have" is simply
-- how many slot rows exist with that shelf and side. The rack-level column was a
-- constraint on that flexibility, not a source of information — so it goes.
--
-- After this, a rack declares only its SHELF COUNT. Sections are added one at a time in the
-- Mapping UI, which is also what makes the interaction direct: you click the shelf face you
-- are looking at and add a section to it.
--
-- CONSEQUENCE — front/back pairing is no longer structural. With per-side section counts,
-- section 3 of side A is not necessarily behind section 3 of side B. "Picked from both
-- sides" therefore stops being a property of a section and becomes what it always physically
-- was: the same SKU assigned on each side. deriveRoute already handles that correctly by
-- taking whichever face the picker reaches first.
--
-- DATA: no rows are lost. Existing slots keep their (shelf, section, side) coordinates and
-- simply stop being constrained to a uniform width. The one rack created under 115 (R1,
-- 3 shelves x 2 sections = 12 slots, none assigned) reads identically afterwards.
--
-- APPLY GATE — Class A by lock footprint, with one caveat worth stating: DROP COLUMN takes
-- ACCESS EXCLUSIVE on pick_racks. That is safe here only because pick_racks is a brand-new
-- table that nothing in the deployed application reads — the Mapping UI is not shipped. It
-- would NOT be safe on a table the live path touches. Run it in its own transaction with
-- SET LOCAL lock_timeout = '3s' regardless.

alter table public.pick_racks
  drop column if exists sections_per_shelf;

-- pick_racks_section_min was a CHECK on the dropped column and goes with it automatically.
-- The shelf minimum stays: a rack with fewer than two shelves is not a rack.
