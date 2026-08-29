-- 115_inventory_mapping.sql
--
-- Inventory mapping: physical racks, addressable slots, and scan-verified picking.
--
-- WHY: pick lines are ordered by inventory_skus.sku_number (api/shipping/pick-list
-- route.ts, "Stable order: lowest SKU# first"). SKU number is a catalogue identity
-- assigned at creation and has no relationship to where an item physically sits, so a
-- multi-SKU order sends the picker back and forth across the floor. There is currently
-- NO location data of any kind — inventory_skus carries only shortcut_letter.
--
-- MODEL — identity and location are deliberately SEPARATE:
--   * A SKU's identity (sku_number / barcode) is stable and never encodes where it lives.
--   * A SLOT is a permanent physical address (rack → shelf → section → side). Its barcode
--     is printed ONCE and never changes.
--   * Which SKU occupies a slot is DATA, reassigned freely in the Mapping UI. Churn is a
--     row update, never a relabelling job. This is the whole point of the design: putting
--     a SKU's own label on the shelf would create two things to keep in sync (the row and
--     the sticker), and they WILL drift.
--
-- NAMING — this migration does NOT touch pick_sections or cubicles. Both exist in prod
-- (pick_sections: 2 rows, cubicles: 5 rows — July-2026 canary data from the never-shipped
-- PR #10 pick/pack pipeline) and pick_sections means something DIFFERENT: it keys a
-- "section" to a SKU's own barcode with no location concept at all. Reusing that name
-- would collide with a live table of the wrong shape. Retiring those orphans is a separate
-- decision and a separate migration.
--
-- SCOPE — user_id, matching the live pick path, which filters .eq('user_id', user.id)
-- throughout (see api/shipping/pick-list/route.ts:139 — "Both stores share a user_id").
-- inventory_skus also carries org_id, but nothing on the live fulfillment path reads it;
-- an org/store cutover would move these tables along with the rest.
--
-- MIN vs MAX — the DB enforces only the physical minimums (a rack has at least 2 shelves,
-- a shelf at least 2 sections). The maximums (5 shelves, 6 sections) are UI constants ON
-- PURPOSE: raising a UI constant is a one-line change, raising a CHECK constraint is
-- another migration and another silence-gated apply.
--
-- APPLY GATE: creates tables and adds one nullable column to employees. inventory_skus is
-- NOT altered. employees is not on the capture/order-sync path, but this is a schema
-- migration, so it is gated on write-activity silence per CLAUDE.md.

-- ========== pick_racks — one row per physical rack ==========
-- grid_row / grid_col are the rack's position on the floor-plan grid. Racks sharing a
-- grid_row form one physical row; the lane between two adjacent rows is an aisle. Aisles
-- are DERIVED from this layout at read time, never stored, so they cannot go stale against
-- the grid.
--
-- Every rack has exactly TWO sides, A and B, and they are fixed: A always faces the
-- lower-numbered aisle ("up" on the grid), B the higher ("down"). Keeping A/B meaningful in
-- one consistent direction is what lets a picker build intuition instead of re-reading the
-- screen at every rack. Two racks in adjacent rows therefore present one face each to the
-- aisle between them — R1's B side and R2's A side are reachable from the same standing
-- position, which is what the route derivation exploits.
--
-- route_pos_a / route_pos_b are OPTIONAL manual overrides of the derived walking order, one
-- per side. NULL (the default) means "use the derived serpentine". They exist because a grid
-- cannot know about a door that does not open, a pallet permanently parked in an aisle, or
-- where the packing station is.
create table if not exists public.pick_racks (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,                                  -- operator-facing, e.g. "R1"
  grid_row integer not null,
  grid_col integer not null,
  shelf_count integer not null default 2,
  sections_per_shelf integer not null default 2,
  route_pos_a integer,                                 -- NULL = derive from grid
  route_pos_b integer,                                 -- NULL = derive from grid
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pick_racks_shelf_min check (shelf_count >= 2),
  constraint pick_racks_section_min check (sections_per_shelf >= 2),
  unique (user_id, name)
);

create index if not exists idx_pick_racks_user on public.pick_racks(user_id);

-- One rack per grid cell, among ACTIVE racks only — a deactivated rack must not hold its
-- cell hostage against the rack that physically replaced it.
create unique index if not exists uniq_pick_racks_cell_active
  on public.pick_racks(user_id, grid_row, grid_col) where is_active;

drop trigger if exists pick_racks_set_updated_at on public.pick_racks;
create trigger pick_racks_set_updated_at
  before update on public.pick_racks
  for each row execute function public.set_updated_at();

alter table public.pick_racks enable row level security;

drop policy if exists "Users can view own pick_racks"   on public.pick_racks;
drop policy if exists "Users can insert own pick_racks" on public.pick_racks;
drop policy if exists "Users can update own pick_racks" on public.pick_racks;
drop policy if exists "Users can delete own pick_racks" on public.pick_racks;

create policy "Users can view own pick_racks"
  on public.pick_racks for select using (auth.uid() = user_id);
create policy "Users can insert own pick_racks"
  on public.pick_racks for insert with check (auth.uid() = user_id);
create policy "Users can update own pick_racks"
  on public.pick_racks for update using (auth.uid() = user_id);
create policy "Users can delete own pick_racks"
  on public.pick_racks for delete using (auth.uid() = user_id);

-- ========== pick_slots — one addressable physical position ==========
-- A slot is (rack, shelf, section, side). A rack whose shape is 2 shelves x 4 sections has
-- 8 section positions and therefore 16 slots, because each position has a front and a back
-- face reachable from different aisles.
--
-- slot_code is the PERMANENT barcode value. It is opaque and carries no address, so moving
-- a rack on the grid changes the human-readable address ("R3A L2 S4") without invalidating
-- a single printed label — the label is reprinted for legibility, never for correctness.
-- Baking the address into the barcode would make every relocation a reprinting job, which
-- is precisely the cost this design exists to avoid.
--
-- The 'LOC-' prefix disambiguates a slot scan from every other barcode the picker's scanner
-- sees: SKU labels ('SKU1042-7K3Q'), employee badges (bare 10-char A–Z2–9), and USPS
-- shipping labels (22 digits). Scan routing is then a prefix test rather than a guess.
-- Generated in application code, matching how inventory_skus.barcode and
-- employee_badges.code are already minted.
--
-- inventory_sku_id is nullable: an empty slot is a normal, expected state (stock sold out,
-- not yet restocked). Scanning an unassigned slot returns "no SKU assigned" rather than an
-- error. ON DELETE SET NULL so retiring a SKU empties its slot instead of destroying the
-- physical address.
--
-- A double-sided SKU is simply the same inventory_sku_id in both the 'A' and 'B' slot of one
-- section. There is deliberately NO is_double_sided flag — it is derivable, and a stored
-- flag could contradict the assignments it claims to describe. Note this means
-- inventory_sku_id is NOT unique here: one SKU legitimately occupies two slots.
create table if not exists public.pick_slots (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  rack_id uuid not null references public.pick_racks(id) on delete cascade,
  shelf_index integer not null,                        -- 1..shelf_count, 1 = bottom
  section_index integer not null,                      -- 1..sections_per_shelf, 1 = left
  side text not null,
  slot_code text not null unique,                      -- 'LOC-' + 10 chars, permanent
  inventory_sku_id uuid references public.inventory_skus(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pick_slots_side_ck check (side in ('A','B')),
  constraint pick_slots_shelf_ck check (shelf_index >= 1),
  constraint pick_slots_section_ck check (section_index >= 1),
  unique (rack_id, shelf_index, section_index, side)
);

create index if not exists idx_pick_slots_user on public.pick_slots(user_id);
create index if not exists idx_pick_slots_rack on public.pick_slots(rack_id);

-- The pick-path read: given the SKUs on an order, find where each one lives.
create index if not exists idx_pick_slots_sku
  on public.pick_slots(user_id, inventory_sku_id) where inventory_sku_id is not null;

drop trigger if exists pick_slots_set_updated_at on public.pick_slots;
create trigger pick_slots_set_updated_at
  before update on public.pick_slots
  for each row execute function public.set_updated_at();

alter table public.pick_slots enable row level security;

drop policy if exists "Users can view own pick_slots"   on public.pick_slots;
drop policy if exists "Users can insert own pick_slots" on public.pick_slots;
drop policy if exists "Users can update own pick_slots" on public.pick_slots;
drop policy if exists "Users can delete own pick_slots" on public.pick_slots;

create policy "Users can view own pick_slots"
  on public.pick_slots for select using (auth.uid() = user_id);
create policy "Users can insert own pick_slots"
  on public.pick_slots for insert with check (auth.uid() = user_id);
create policy "Users can update own pick_slots"
  on public.pick_slots for update using (auth.uid() = user_id);
create policy "Users can delete own pick_slots"
  on public.pick_slots for delete using (auth.uid() = user_id);

-- ========== employees.override_pin_hash — who may authorize a skipped scan ==========
-- Scan-verified picking has to have an escape hatch: a damaged or unreadable slot label
-- would otherwise hard-block the order, and a picker with no sanctioned way through invents
-- an unsanctioned one — at which point the data is worse than having no control at all.
--
-- A SEPARATE column from the existing employees.pin_hash, which migration 091 added as a
-- reserved placeholder for a kiosk PIN flow ("column ONLY. No PIN flow is built or enforced
-- here") and which is still unset on all 37 employees. Keeping them distinct means (a) the
-- future kiosk PIN flow is not silently granted override authority, and (b) a lead's
-- override secret is not the PIN they type at the clock in front of the whole floor.
--
-- Having an override_pin_hash IS the authorization — no separate role flag. employees.role
-- is deliberately NOT overloaded for this: it feeds payroll filtering and is constrained to
-- pay-role classes in the scheduling schema, so a new value there could move money.
--
-- Per-lead PINs rather than one shared code, because a shared code becomes floor knowledge
-- and pickers then self-authorize while the log still reads "authorized". Per-person PINs
-- make that visible: the authorizing lead can be cross-checked against who was clocked in.
-- Store a HASH, never the PIN.
alter table public.employees
  add column if not exists override_pin_hash text;

-- ========== pick_overrides — the audit trail for every skipped scan ==========
-- Append-only. One row per override, surfaced as a review list. The rate is the signal
-- worth watching, not the secrecy of any individual PIN: a picker whose overrides spike, or
-- a lead authorizing during shifts they did not work, is legible here regardless of whether
-- the PINs stayed private.
--
-- slot_id is nullable — the common override is precisely the case where the picker cannot
-- produce a slot scan at all. inventory_sku_id records which line was completed anyway.
-- Employee references are ON DELETE SET NULL so removing an employee never destroys the
-- history of what was authorized.
create table if not exists public.pick_overrides (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  group_key text,                                      -- the box, matching shipment_verifications
  slot_id uuid references public.pick_slots(id) on delete set null,
  inventory_sku_id uuid references public.inventory_skus(id) on delete set null,
  picker_employee_id uuid references public.employees(id) on delete set null,
  authorized_by_employee_id uuid references public.employees(id) on delete set null,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_pick_overrides_user_created
  on public.pick_overrides(user_id, created_at desc);
create index if not exists idx_pick_overrides_picker
  on public.pick_overrides(picker_employee_id, created_at desc);

alter table public.pick_overrides enable row level security;

drop policy if exists "Users can view own pick_overrides"   on public.pick_overrides;
drop policy if exists "Users can insert own pick_overrides" on public.pick_overrides;

-- Read + insert only. No update/delete policy by design: an audit trail that can be edited
-- or quietly deleted is not an audit trail.
create policy "Users can view own pick_overrides"
  on public.pick_overrides for select using (auth.uid() = user_id);
create policy "Users can insert own pick_overrides"
  on public.pick_overrides for insert with check (auth.uid() = user_id);
