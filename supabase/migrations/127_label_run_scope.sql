-- What a label run was FOR, in the operator's own terms.
--
-- The ledger records every box a run bought, but not the question that produced it: "Thursday
-- night" or "those three shows". Reconstructing that from the rows is guesswork — a run's boxes
-- span several nights whenever a combine group straddles 04:00, so the dates in the data do not
-- name the scope that was chosen.
--
-- Needed for the print history, where a run has to be recognisable a week later so the right
-- stack can be reprinted. Written once at authorisation, same as print_seq and the captions, and
-- for the same reason: it cannot be re-derived afterwards.
--
-- Nullable; rows predating it show as an unnamed run rather than disappearing from the history.

alter table shipping_label_purchases
  add column if not exists run_scope text;

comment on column shipping_label_purchases.run_scope is
  'Human description of what the run covered, e.g. "day 2026-09-03" or "3 lives". Set at '
  'authorisation; not derivable from the rows, since a run''s boxes can span several nights.';

-- The history lists runs newest-first for one store.
create index if not exists shipping_label_purchases_history_idx
  on shipping_label_purchases (user_id, store_id, purchased_at desc);
