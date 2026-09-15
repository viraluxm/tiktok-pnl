#!/usr/bin/env python3
"""READ-ONLY preview of migration 155's reconciliation, running the IDENTICAL replay algorithm
in Python against ONE consistent production snapshot. Touches nothing.

Covers both scopes the migration acts on:
  GROUP 1 PROMOTE_PENDING  legacy + $0            -> (NULL,'pending',authoritative)
  GROUP 2 RECOVER_FINAL    final + !authoritative + created_at < the 152 apply time
                           -> keep the typed cost, make attributable, reprice stranded $0 lines
"""
import json, collections, sys

SNAP = sys.argv[1]
CUTOFF = '2026-09-13T00:56:47+00:00'
snap = json.load(open(SNAP))
layers, lines = snap['layers'], snap['lines']

def g1(b): return b['cost_status'] == 'legacy' and b['unit_cost_cents'] == 0
def g2(b): return (b['cost_status'] == 'final' and not b['qty_added_authoritative']
                   and b['created_at'] < CUTOFF)

by_sku = collections.defaultdict(list)
for b in layers: by_sku[b['sku_id']].append(b)
lines_by_sku = collections.defaultdict(list)
for n in lines: lines_by_sku[n['sku_id']].append(n)

results, seq_ties = [], []
for sku_id, ls in by_sku.items():
    ls = sorted(ls, key=lambda x: x['sequence'])
    scope = [b for b in ls if g1(b) or g2(b)]
    if not scope: continue
    num, title = ls[0]['sku_number'], ls[0]['title']
    seqs = [b['sequence'] for b in ls]
    if len(set(seqs)) != len(seqs): seq_ties.append(num)
    verdict, detail, alloc = 'RECONSTRUCTABLE', None, {}

    if any(b['qty_added'] is None for b in ls):
        verdict = 'AMBIGUOUS_QTY_ADDED_NULL'
        detail = 'a layer on this SKU has qty_added IS NULL (migration-034 backfill shape)'
    else:
        sim = {b['id']: b['qty_added'] for b in ls}
        for n in sorted(lines_by_sku.get(sku_id, []), key=lambda n: (n['drawn_at'], n['id'])):
            pick = None
            for b in ls:
                if b['created_at'] <= n['drawn_at'] and sim[b['id']] >= n['qty']:
                    pick = b['id']; break
            if pick is None:                       # oversell -> newest already-existing layer
                cand = [b for b in ls if b['created_at'] <= n['drawn_at']]
                pick = cand[-1]['id'] if cand else None
            if pick is None:
                verdict = 'AMBIGUOUS_QUANTITY_UNRECONCILED'
                detail = 'a sold line predates every layer on this SKU'; break
            sim[pick] -= n['qty']; alloc[n['id']] = pick
        if verdict == 'RECONSTRUCTABLE':
            bad = [b for b in ls if sim[b['id']] != b['qty_remaining']]
            if bad:
                verdict = 'AMBIGUOUS_QUANTITY_UNRECONCILED'
                detail = f"{len(bad)} layer(s) end the replay at a different quantity than the database holds"
        if verdict == 'RECONSTRUCTABLE':
            gt = [n for n in lines_by_sku.get(sku_id, []) if n['source_batch_id']]
            bad = [n for n in gt if alloc.get(n['id']) != n['source_batch_id']]
            if bad:
                verdict = 'AMBIGUOUS_REPLAY_CONTRADICTS_RECORDED'
                detail = f"{len(bad)} of {len(gt)} post-153 lines contradict the replay"

    sl = lines_by_sku.get(sku_id, [])
    for b in scope:
        mode = 'PROMOTE_PENDING' if g1(b) else 'RECOVER_FINAL'
        attr = [n for n in sl if not n['source_batch_id'] and alloc.get(n['id']) == b['id']]
        already = [n for n in sl if n['source_batch_id'] == b['id']]
        rep = ([n for n in sl if n['snap'] == 0
                and (n['source_batch_id'] == b['id']
                     or (not n['source_batch_id'] and alloc.get(n['id']) == b['id']))]
               if mode == 'RECOVER_FINAL' and verdict == 'RECONSTRUCTABLE' else [])
        results.append(dict(
            sku_number=num, title=title, batch=b['id'], mode=mode, verdict=verdict, detail=detail,
            cost=b['unit_cost_cents'], qty_added=b['qty_added'], qty_remaining=b['qty_remaining'],
            lines=len(attr), units=sum(n['qty'] for n in attr),
            rep_lines=len(rep), rep_units=sum(n['qty'] for n in rep),
            already_lines=len(already), already_units=sum(n['qty'] for n in already),
            gt=len([n for n in sl if n['source_batch_id']])))

ok  = [r for r in results if r['verdict'] == 'RECONSTRUCTABLE']
amb = [r for r in results if r['verdict'] != 'RECONSTRUCTABLE']
G1  = [r for r in ok if r['mode'] == 'PROMOTE_PENDING']
G2  = [r for r in ok if r['mode'] == 'RECOVER_FINAL']
cogs = sum(r['rep_units'] * r['cost'] for r in G2)

W = 98
print('=' * W)
print('PRODUCTION RECONCILIATION PREVIEW — migration 155 (NOTHING APPLIED)')
print(f"snapshot taken at {snap['taken_at']}   (single consistent read: layers and lines together)")
print('=' * W)
print(f"Candidate layers in scope:          {len(results)}")
print(f"  Reconstructable:                  {len(ok)}   ({len(G1)} PROMOTE_PENDING + {len(G2)} RECOVER_FINAL)")
print(f"  Ambiguous (refused, untouched):   {len(amb)}")
print()
print(f"Historical sale LINES to attribute: {sum(r['lines'] for r in ok)}")
print(f"Historical UNITS to attribute:      {sum(r['units'] for r in ok)}")
print(f"Existing attributions preserved:    {sum(r['already_lines'] for r in ok)}  (never overwritten)")
print(f"Post-153 ground-truth lines the replay reproduced exactly: "
      f"{sum(r['gt'] for r in {x['sku_number']: x for x in ok}.values())}")
print()
print(f"GROUP 2 immediate repricing:        {sum(r['rep_lines'] for r in G2)} lines / "
      f"{sum(r['rep_units'] for r in G2)} units, all currently stranded at $0")
print(f"GROUP 2 COGS correction:            +${cogs/100:,.2f}   (this is the only P&L movement)")
print(f"GROUP 1 COGS movement:              $0.00   (cost becomes NULL/pending; priced later by the user)")
if seq_ties: print(f"\n⚠ duplicate layer sequence on SKUs {seq_ties} — replay order would be ambiguous")
print()
print('-' * W)
print(f"{'SKU':>5} {'title':26} {'mode':15} {'cost':>7} {'added':>6} {'rem':>5} {'attr':>5} {'repr':>5}")
print('-' * W)
for r in sorted(G2, key=lambda x: x['sku_number']):
    print(f"{r['sku_number']:>5} {r['title']:26.26} {r['mode']:15} "
          f"${r['cost']/100:>6.2f} {r['qty_added']:>6} {r['qty_remaining']:>5} {r['lines']:>5} {r['rep_lines']:>5}")
print(f"  ── and {len(G1)} PROMOTE_PENDING layers (top 10 by units attributed) ──")
for r in sorted(G1, key=lambda x: -x['units'])[:10]:
    print(f"{r['sku_number']:>5} {r['title']:26.26} {r['mode']:15} "
          f"{'$  0.00':>7} {r['qty_added']:>6} {r['qty_remaining']:>5} {r['lines']:>5} {r['rep_lines']:>5}")
print()
print('AMBIGUOUS (refused — nothing changes on these):')
for r in amb:
    print(f"  SKU {r['sku_number']:>4} {r['title']:26.26} [{r['mode']}] added={r['qty_added']} rem={r['qty_remaining']}")
    print(f"       {r['verdict']}: {r['detail']}")
if not amb: print('  (none)')
nosale = [r for r in G1 if r['lines'] == 0 and r['already_lines'] == 0]
print(f"\nOf the {len(G1)} PROMOTE_PENDING layers, {len(nosale)} have no sales at all yet.")
