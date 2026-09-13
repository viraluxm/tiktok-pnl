#!/usr/bin/env python3
"""READ-ONLY preview of migration 155's reconciliation, running the IDENTICAL replay
algorithm in Python against a production snapshot. Touches nothing."""
import json, collections
SP='/private/tmp/claude-501/-Users-abe-tiktok-pnl/e75cf398-25d4-447e-8d9f-09ab50ab7e1d/scratchpad'
layers=json.load(open(f'{SP}/preview/layers.json'))
lines=json.load(open(f'{SP}/preview/lines.json'))

by_sku=collections.defaultdict(list)
for l in layers: by_sku[l['sku_id']].append(l)
lines_by_sku=collections.defaultdict(list)
for n in lines: lines_by_sku[n['sku_id']].append(n)

results=[]
for sku_id, ls in by_sku.items():
    ls=sorted(ls, key=lambda x: x['sequence'])
    zero=[b for b in ls if b['cost_status']=='legacy' and b['unit_cost_cents']==0]
    if not zero: continue
    num=ls[0]['sku_number']; title=ls[0]['title']
    verdict='RECONSTRUCTABLE'; detail=None; alloc={}

    if any(b['qty_added'] is None for b in ls):
        verdict='AMBIGUOUS_QTY_ADDED_NULL'
        detail='a layer on this SKU has qty_added IS NULL (migration-034 backfill shape)'
    else:
        sim={b['id']: b['qty_added'] for b in ls}
        sl=sorted(lines_by_sku.get(sku_id,[]), key=lambda n:(n['drawn_at'], n['id']))
        for n in sl:
            pick=None
            for b in ls:
                if b['created_at']<=n['drawn_at'] and sim[b['id']]>=n['qty']:
                    pick=b['id']; break
            if pick is None:   # oversell -> newest existing layer
                cand=[b for b in ls if b['created_at']<=n['drawn_at']]
                pick=cand[-1]['id'] if cand else None
            if pick is None:
                verdict='AMBIGUOUS_QUANTITY_UNRECONCILED'
                detail='a sold line predates every layer on this SKU'; break
            sim[pick]-=n['qty']; alloc[n['id']]=pick
        if verdict=='RECONSTRUCTABLE':
            bad=[b for b in ls if sim[b['id']]!=b['qty_remaining']]
            if bad:
                verdict='AMBIGUOUS_QUANTITY_UNRECONCILED'
                detail=f"{len(bad)} layer(s) end the replay at a different quantity than the database holds"
        if verdict=='RECONSTRUCTABLE':
            gt=[n for n in lines_by_sku.get(sku_id,[]) if n['source_batch_id']]
            bad=[n for n in gt if alloc.get(n['id'])!=n['source_batch_id']]
            if bad:
                verdict='AMBIGUOUS_REPLAY_CONTRADICTS_RECORDED'
                detail=f"{len(bad)} of {len(gt)} post-153 lines contradict the replay"

    for b in zero:
        to_attr=[n for n in lines_by_sku.get(sku_id,[]) if not n['source_batch_id'] and alloc.get(n['id'])==b['id']]
        already=[n for n in lines_by_sku.get(sku_id,[]) if n['source_batch_id']==b['id']]
        results.append(dict(sku_number=num, title=title, batch=b['id'], verdict=verdict, detail=detail,
            qty_added=b['qty_added'], qty_remaining=b['qty_remaining'],
            lines=len(to_attr), units=sum(n['qty'] for n in to_attr),
            already_lines=len(already), already_units=sum(n['qty'] for n in already),
            gt=len([n for n in lines_by_sku.get(sku_id,[]) if n['source_batch_id']])))

ok=[r for r in results if r['verdict']=='RECONSTRUCTABLE']
amb=[r for r in results if r['verdict']!='RECONSTRUCTABLE']
print('='*96)
print('PRODUCTION RECONCILIATION PREVIEW — migration 155 (NOTHING APPLIED)')
print('='*96)
print(f"Legacy $0 batches found:            {len(results)}")
print(f"  Fully reconstructable:            {len(ok)}")
print(f"  Ambiguous (refused):              {len(amb)}")
print()
print(f"Historical sale LINES to attribute: {sum(r['lines'] for r in ok)}")
print(f"Historical UNITS to attribute:      {sum(r['units'] for r in ok)}")
print(f"Existing attributed lines preserved:{sum(r['already_lines'] for r in ok)}  (never overwritten)")
print(f"Conflicts:                          0")
print(f"Batches to promote:                 {len(ok)}")
print(f"Audit rows to be written:           {len(ok)}")
print()
print(f"Post-153 ground-truth lines the replay had to reproduce exactly: {sum(r['gt'] for r in ok)}")
print()
print('-'*96)
print(f"{'SKU':>5} {'title':30} {'added':>6} {'remain':>7} {'lines':>6} {'units':>6} {'kept':>5}  verdict")
print('-'*96)
for r in sorted(ok, key=lambda x:-x['units'])[:18]:
    print(f"{r['sku_number']:>5} {r['title']:30.30} {r['qty_added']:>6} {r['qty_remaining']:>7} {r['lines']:>6} {r['units']:>6} {r['already_lines']:>5}  {r['verdict']}")
print(f"   ... {max(0,len(ok)-18)} more reconstructable batches")
print()
print('AMBIGUOUS (refused, nothing changed):')
for r in amb:
    print(f"  SKU {r['sku_number']:>4} {r['title']:30.30} qty_added={r['qty_added']} remain={r['qty_remaining']}")
    print(f"       {r['verdict']}: {r['detail']}")
zero_no_sales=[r for r in ok if r['lines']==0 and r['already_lines']==0]
print()
print(f"Of the {len(ok)} reconstructable, {len(zero_no_sales)} have no sales at all yet "
      f"(promotion just makes them pending so a cost can be entered normally).")
