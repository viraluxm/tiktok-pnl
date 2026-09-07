-- When a label was first handed to a printer.
--
-- The print history could say what a run cost and how it was split, but not the one thing an
-- operator actually looks for the morning after: has this stack been printed yet? A bought run
-- and a printed run look identical, so the only way to tell is to remember — and a run that
-- silently never got printed is a day of parcels that never ship.
--
-- FIRST print, not last. Reprints are routine (a jam, a stack split across stations, a lost
-- pile) and must not look like new work, so this is set once and left alone.
--
-- Per ROW rather than per run, because the stack is served in slices of about 60 labels: a
-- download interrupted halfway has genuinely printed some of its labels and not others, and
-- rolling that up to the run would claim more than happened.

alter table shipping_label_purchases
  add column if not exists printed_at timestamptz;

comment on column shipping_label_purchases.printed_at is
  'When this label was first included in a served PDF. Set once; reprints do not change it.';

-- The history asks "how many of this run are printed" for every run it lists.
create index if not exists shipping_label_purchases_printed_idx
  on shipping_label_purchases (user_id, run_id) where printed_at is null;
