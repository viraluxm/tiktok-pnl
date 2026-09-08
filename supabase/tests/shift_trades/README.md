# Shift trades — migration 136 DB harness

Executable verification for `supabase/migrations/136_shift_trades.sql` (the `shift_trades` table and
the `lensed_approve_shift_trade` RPC behind the employee portal's one-for-one trade).

Same shape as `../schedule_phase2`: a THROWAWAY Postgres 16 in Docker, the real repo migrations
(044/047/085/086/090/129/130) applied on top of the shared stub bootstrap, then the real 136 file
verbatim, then assertions. It never contacts a hosted database and reads no `.env*`.

```bash
supabase/tests/shift_trades/run.sh
```

| File | Covers |
|---|---|
| `catalog.sql` | diffable projection of everything 136 creates |
| `harness.sql` | trade fixture builder + refusal helper (on top of `../schedule_phase2/harness.sql`) |
| `seed.sql` | adds a fulfillment employee to the Phase 2 roster for the role-mismatch case |
| `test_constraints.sql` | status/response vocabulary, two-people/two-shifts, stage checks, live-trade unique indexes |
| `test_rpc.sql` | happy path (different days AND same day), replay, every refusal path with non-mutation |
| `test_atomicity.sql` | double-booked swap rolls all three steps back; a post-swap failure rolls the transfer back |
| `run.sh` | orchestration + grants, out-of-transaction rollback, idempotence |
