# Lensed — Section / Location Redesign (Design Spec)

**Status:** design only — **not built**. Captured now; build **after** the identity/auth phase completes. We are mid-auth-phase (chunk 4 next); this is parked.

---

## 1. The decided model: racks as coarse zones, SKU identity separate from location

- **Sections = racks** (coarse physical zones). 8 racks → 8 sections. A section tells the picker **which rack** an item is on — **coarse guidance, not a precise slot**.
- **SKU shelf label = the SKU's barcode + the SKU number shown HUGE** below it (e.g. big "**#14**"), so the picker spots it **by eye** once at the right rack.
- **SKU ↔ rack is a reassignable mapping** (e.g. SKU 14 → rack 3). Moving an item = **change the rack mapping** + physically move the item and its big label. The **SKU number is stable** (identity); **only the rack assignment changes**.

### Picker flow
1. Screen shows "**SKU #14 — Rack 3**" (rack = guidance text).
2. Picker walks to **rack 3**, finds the big "**#14**" label **by eye**.
3. **Scans the SKU barcode** to confirm. **ONE scan (the item).** Rack is guidance, **not a separate scan**.

### Why this replaces the current model
Today **"section = the SKU's own barcode"** with **no location concept** — the section barcode *is* the SKU barcode, so there's no notion of where the item physically lives, and SKU identity is conflated with its "section." The new model **separates SKU identity (stable) from location (rack, reassignable)**, fixing the failure mode where deactivating/moving a SKU corrupts the numbering/location coupling. Identity (the SKU number) never moves; location (rack) is just a mapping you edit.

---

## 2. Rough data-model direction (for the future build — not final)

- **`racks`** (org-shared): `id, org_id, name/number (e.g. "Rack 3"), is_active`. ~one row per physical rack.
- **SKU → rack assignment:** a reassignable mapping — either a column on `inventory_skus` (e.g. `rack_id`) **or** a join table `sku_rack_assignments(inventory_sku_id, rack_id, org_id)`. A column is simplest if a SKU lives on exactly one rack at a time (matches "SKU 14 → rack 3"); the join table only if a SKU can span racks (probably not). Decide at build time.
- **The scan still resolves to the SKU** via `inventory_skus.barcode` (the SKU label's barcode) — **unchanged**. The rack is **display-only guidance** derived from the SKU→rack mapping; it is **not** scanned.
- Pick-line shape gains a **rack label** for guidance (resolved live from the SKU→rack mapping, like the current live section lookup), while the scan-match stays keyed on the SKU barcode.

*(Final schema/constraints decided when we build this — this section is direction only.)*

---

## 3. ⚠️ Migration implication — reconcile with the current `pick_sections` work

When we build this, it **reworks the current `pick_sections` concept**, which today stores `section_barcode = the SKU's own barcode`. Specifically, the following will need reconciling:

- **`pick_sections` table** — today: one row per SKU, `section_barcode = inventory_skus.barcode`, `inventory_sku_id`, `label`, partial-unique one-active-section-per-SKU. This concept **collapses/migrates** into: `racks` (coarse zones) + a **SKU→rack assignment**. `pick_sections` is either repurposed or retired.
- **The existing `#13` / `#14` sections** (created on the unified-barcode scheme, `section_barcode = SKU13-BAA4 / SKU14-E9AB`) — these are **SKU-keyed, not rack-keyed**. They'll need migrating to the new shape: keep the SKU↔barcode (scan still works), drop the "section = barcode" coupling, and add a rack assignment per SKU.
- **The unified-barcode work** (rev: `section_barcode = inventory_skus.barcode`, the SKU label doing double duty for bind + pick) — the **SKU barcode remains the scan key** in the new model, so that unification is **preserved**. What changes is that the *location* is no longer "the section barcode" but a separate **rack mapping** + the big visual SKU number on the label.
- **`scan-section` endpoint + its fallback** — today resolves a scanned value against `pick_sections.section_barcode` then falls back to `inventory_skus.barcode`. In the new model, the scan resolves directly to the SKU (barcode), and the **rack is looked up for display only**. The endpoint will simplify (scan → SKU → match line; rack is guidance, not validated by a separate scan).
- **Settings UI** (`/pickpack/settings` "Sections") — becomes **rack management** (define racks) + **SKU→rack assignment** (reassignable), instead of "map a section barcode to a SKU." The printable label changes to "**SKU barcode + huge #N**."
- **`fulfillment_lines.expected_section_id` / `expected_section_label`** — repoint from a `pick_sections` row to the SKU's **current rack** (live lookup), so reassigning a rack updates guidance everywhere without rebuilding boxes (same live-lookup principle already used for the "no section mapped" flag).

**Net:** SKU identity + SKU barcode scan = **unchanged/preserved**; the "section = barcode" location concept is **replaced** by racks + a reassignable SKU→rack mapping. Plan a small reconciliation migration (repurpose/retire `pick_sections`, introduce `racks` + assignment, migrate the #13/#14 mappings) when this is built.

---

## 4. Sequencing
- **Not now.** Finish the identity/auth phase first (currently at chunk 4 — shift/break model).
- Build this **after** the auth phase, as its own reviewed mini-phase (racks table + assignment + Settings rework + scan/endpoint simplification + the `pick_sections` reconciliation migration).

---

*Captured for later. Build nothing now; continue the auth phase (chunk 4) next.*
