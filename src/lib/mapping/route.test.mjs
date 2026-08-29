// Proof for the pick-route derivation: which aisle each rack face opens onto, the
// serpentine walking order, and how manual overrides resolve against it. Transpiles
// route.ts (no imports) at runtime — same pattern as eligibility.test.mjs.
// Run:  node src/lib/mapping/route.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./route.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'route-')), 'route.mjs');
writeFileSync(outFile, outputText);
const { deriveRoute, routePositionMap, pickerLabel, slotAddress } = await import(
  pathToFileURL(outFile).href
);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const rack = (id, name, row, col, a = null, b = null) => ({
  id, name, grid_row: row, grid_col: col, route_pos_a: a, route_pos_b: b, is_active: true,
});

const labelsInOrder = (stops) => stops.slice().sort((x, y) => x.position - y.position).map((s) => s.label);
const aisleOf = (stops, label) => stops.find((s) => s.label === label).aisle;

console.log('\nAisle derivation');
{
  // The user's own example: two racks in adjacent rows face each other across one aisle.
  const stops = deriveRoute([rack('1', 'R1', 0, 0), rack('2', 'R2', 1, 0)]);
  check(
    'R1B and R2A open onto the SAME aisle',
    aisleOf(stops, 'R1B') === aisleOf(stops, 'R2A'),
    `R1B=${aisleOf(stops, 'R1B')} R2A=${aisleOf(stops, 'R2A')}`,
  );
  check('R1A is on the outer aisle above', aisleOf(stops, 'R1A') === 0);
  check('R2B is on the outer aisle below', aisleOf(stops, 'R2B') === 2);
  check('every face appears exactly once', stops.length === 4);
}
{
  // A row of racks with nothing above or below still has an aisle on each side.
  const stops = deriveRoute([rack('1', 'R1', 0, 0), rack('2', 'R2', 0, 1)]);
  const aisles = new Set(stops.map((s) => s.aisle));
  check('one row yields exactly two aisles', aisles.size === 2, [...aisles].join(','));
  check('both A faces share the upper aisle', aisleOf(stops, 'R1A') === aisleOf(stops, 'R2A'));
  check('both B faces share the lower aisle', aisleOf(stops, 'R1B') === aisleOf(stops, 'R2B'));
}
{
  // Non-contiguous grid rows are still adjacent as OCCUPIED rows — a gap in the numbering
  // is not a physical gap, so it must not invent a phantom aisle between them.
  const stops = deriveRoute([rack('1', 'R1', 0, 0), rack('2', 'R2', 7, 0)]);
  check(
    'a gap in row numbering does not create an extra aisle',
    aisleOf(stops, 'R1B') === aisleOf(stops, 'R2A'),
  );
}

console.log('\nSerpentine walking order');
{
  //   aisle 0:  R1A R2A R3A          →  walked left-to-right
  //   aisle 1:  R1B R2B R3B          ←  walked right-to-left
  const racks = [rack('1', 'R1', 0, 0), rack('2', 'R2', 0, 1), rack('3', 'R3', 0, 2)];
  const order = labelsInOrder(deriveRoute(racks, 'top-left'));
  check(
    'first aisle runs left-to-right, second reverses',
    order.join(' ') === 'R1A R2A R3A R3B R2B R1B',
    order.join(' '),
  );
}
{
  const racks = [rack('1', 'R1', 0, 0), rack('2', 'R2', 0, 1), rack('3', 'R3', 0, 2)];
  const order = labelsInOrder(deriveRoute(racks, 'top-right'));
  check(
    'starting from the right mirrors the serpentine',
    order.join(' ') === 'R3A R2A R1A R1B R2B R3B',
    order.join(' '),
  );
}
{
  const racks = [rack('1', 'R1', 0, 0), rack('2', 'R2', 1, 0)];
  const top = labelsInOrder(deriveRoute(racks, 'top-left'));
  const bottom = labelsInOrder(deriveRoute(racks, 'bottom-left'));
  check('starting at the bottom walks the aisles in reverse', top[0] === 'R1A' && bottom[0] === 'R2B',
    `${top[0]} vs ${bottom[0]}`);
}
{
  // The property the whole feature rests on: positions are a dense, unique 0..n-1 ordering,
  // so sorting pick lines by them can never leave two stops tied or unreachable.
  const racks = [rack('1', 'R1', 0, 0), rack('2', 'R2', 0, 1), rack('3', 'R3', 1, 0), rack('4', 'R4', 1, 1)];
  const stops = deriveRoute(racks);
  const positions = stops.map((s) => s.position).sort((a, b) => a - b);
  check(
    'positions are dense and unique',
    positions.length === 8 && positions.every((p, i) => p === i),
    positions.join(','),
  );
}
{
  // Racks facing each other across an aisle at the same column must not tie.
  const racks = [rack('1', 'R1', 0, 3), rack('2', 'R2', 1, 3)];
  const stops = deriveRoute(racks);
  const mid = stops.filter((s) => s.label === 'R1B' || s.label === 'R2A');
  check('same-column facing racks get distinct positions', mid[0].position !== mid[1].position);
}

console.log('\nManual overrides');
{
  //  Derived order is R1A R2A R3A R3B R2B R1B. Pin R1B (derived last) to the front.
  const racks = [rack('1', 'R1', 0, 0, null, 0), rack('2', 'R2', 0, 1), rack('3', 'R3', 0, 2)];
  const stops = deriveRoute(racks);
  const order = labelsInOrder(stops);
  check('an overridden stop moves to its pinned position', order[0] === 'R1B', order.join(' '));
  check('the override is flagged', stops.find((s) => s.label === 'R1B').overridden === true);
  check(
    'non-overridden stops keep their derived order',
    order.slice(1).join(' ') === 'R1A R2A R3A R3B R2B',
    order.join(' '),
  );
  check(
    'positions stay dense after an override',
    stops.map((s) => s.position).sort((a, b) => a - b).every((p, i) => p === i),
  );
}
{
  const racks = [rack('1', 'R1', 0, 0), rack('2', 'R2', 0, 1)];
  const stops = deriveRoute(racks);
  check('with no overrides nothing is flagged', stops.every((s) => !s.overridden));
  check('derivedIndex is preserved alongside position',
    stops.every((s) => typeof s.derivedIndex === 'number'));
}

console.log('\nActive filtering and edge cases');
{
  const racks = [rack('1', 'R1', 0, 0), { ...rack('2', 'R2', 0, 1), is_active: false }];
  const stops = deriveRoute(racks);
  check('inactive racks are excluded', stops.length === 2 && stops.every((s) => s.rackName === 'R1'));
}
{
  check('no racks yields no stops', deriveRoute([]).length === 0);
  check('all-inactive yields no stops',
    deriveRoute([{ ...rack('1', 'R1', 0, 0), is_active: false }]).length === 0);
}
{
  // is_active is optional on the input type; absent must mean active, not excluded.
  const stops = deriveRoute([{ id: '1', name: 'R1', grid_row: 0, grid_col: 0, route_pos_a: null, route_pos_b: null }]);
  check('a rack with is_active absent is treated as active', stops.length === 2);
}

console.log('\nLookup map and labels');
{
  const racks = [rack('1', 'R1', 0, 0), rack('2', 'R2', 0, 1)];
  const m = routePositionMap(racks);
  const stops = deriveRoute(racks);
  check('map has one entry per rack-side', m.size === 4);
  check('map agrees with deriveRoute',
    stops.every((s) => m.get(`${s.rackId}:${s.side}`) === s.position));
}
{
  check('picker label stops at the level', pickerLabel('R3', 'A', 2) === 'R3A L2');
  check('slot address includes the section', slotAddress('R3', 'A', 2, 4) === 'R3A L2 S4');
  check('side B renders distinctly', pickerLabel('R3', 'B', 2) === 'R3B L2');
}

console.log(`\n${passed} checks passed\n`);
