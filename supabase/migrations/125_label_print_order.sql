-- Persist each purchased box's position in the print stack.
--
-- WHY THE LEDGER HAS TO CARRY THIS. The print order comes from the label plan, which is built
-- from live order data — but buying a label moves its order to AWAITING_COLLECTION, so minutes
-- later the planner can no longer find it. Re-deriving the order at print time would therefore
-- mean re-planning a DIFFERENT candidate set, and SKU batching depends on the whole set: the
-- same box can be a batch member in one run and a demoted singleton in the next. The stack
-- would not match what was reviewed.
--
-- So the purchase job writes down where each box belongs at the moment it buys, and assembly
-- reads only the ledger. That also makes reprinting a run from last week possible, which
-- re-planning never could be.
--
-- slip_caption is the section header the box sits under ('#248 PUMPKIN GLITTER', or
-- 'MIXED — READ EACH LABEL'). Consecutive rows sharing a caption form one section, so the
-- sequence — including each slip's count — reconstructs exactly from these two columns.

alter table shipping_label_purchases
  add column if not exists print_seq int,
  add column if not exists slip_caption text;

comment on column shipping_label_purchases.print_seq is
  'Position of this box in its run''s print stack, 0-based. Assigned at purchase from the '
  'reviewed plan, because the plan cannot be re-derived once the order advances.';
comment on column shipping_label_purchases.slip_caption is
  'Section header this box prints under. Consecutive rows sharing a caption are one section.';

-- Assembly reads a whole run in print order.
create index if not exists shipping_label_purchases_print_order_idx
  on shipping_label_purchases (run_id, print_seq);
