-- Which PILE a purchased box belongs to, alongside which SKU section it sits in.
--
-- The printed stack has two levels and they answer different questions. A per-SKU slip tells a
-- packer what to grab next ("#248 PUMPKIN GLITTER · 12"). A BANNER tells whoever splits the
-- stack which pile they are holding: singles, mixed, or no-SKU-on-file. Only the banner
-- survives the stack being carried to a different station, and that split is the point of the
-- whole feature — singles are 38-51% of a day's boxes (measured over the 8 days to 2026-09-04)
-- and go to a dedicated prep station where one SKU is packed over and over.
--
-- Stored for the same reason print_seq is (migration 125): the plan cannot be re-derived once an
-- order advances out of the candidate set, so anything the printed stack needs has to be written
-- down at purchase time.
--
-- Nullable, and null on the rows that predate it. Those still print — assembly treats a box with
-- no banner as its own unheaded run rather than dropping it.

alter table shipping_label_purchases
  add column if not exists banner_caption text;

comment on column shipping_label_purchases.banner_caption is
  'Pile this box prints under: SINGLES / MIXED / NO SKU ON FILE. Coarser than slip_caption, '
  'which names the SKU section within the singles pile.';
