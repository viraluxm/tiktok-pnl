// Proof for the isometric rack projection: the axes point where the drawing assumes they
// point, visible faces are the three a viewer can actually see, depth ordering puts near
// boxes last, and a both-sides section really is one box two rows deep.
// Run:  node src/lib/mapping/iso.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./iso.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'iso-')), 'iso.mjs');
writeFileSync(outFile, outputText);
const { project, boxFaces, paintOrder, bounds, toPoints, depthFor, layoutShelf, layoutRack, ROW_GAP, ISO } =
  await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const box = (x, z, d = 1, baseY = 0, w = 1, h = ISO.BOX_H) => ({ x, z, w, d, baseY, h });

console.log('\nProjection axes');
{
  const o = project(0, 0, 0);
  check('the origin projects to the origin', o.x === 0 && o.y === 0);
}
{
  const a = project(0, 0, 0);
  const b = project(1, 0, 0);
  check('moving along the shelf goes right', b.x > a.x, `${a.x} → ${b.x}`);
  check('…and down the screen', b.y > a.y, `${a.y} → ${b.y}`);
}
{
  const a = project(0, 0, 0);
  const b = project(0, 1, 0);
  check('moving toward the front goes left', b.x < a.x, `${a.x} → ${b.x}`);
  check('…and down the screen', b.y > a.y, `${a.y} → ${b.y}`);
}
{
  const floor = project(0, 0, 0);
  const up = project(0, 0, 50);
  check('height goes UP the screen (smaller y)', up.y < floor.y, `${floor.y} → ${up.y}`);
}
{
  // 2:1 dimetric — one step along x should cover twice the horizontal of the vertical.
  const a = project(0, 0, 0);
  const b = project(1, 0, 0);
  check('the projection is 2:1', Math.abs((b.x - a.x) / (b.y - a.y) - 2) < 1e-9,
    String((b.x - a.x) / (b.y - a.y)));
}

console.log('\nBox faces');
{
  const f = boxFaces(box(0, 0));
  check('three faces are emitted', Object.keys(f).length === 3);
  check('each face is a quad',
    f.top.length === 4 && f.right.length === 4 && f.front.length === 4);
  check('hidden faces are not emitted', !('back' in f) && !('bottom' in f) && !('left' in f));
}
{
  const f = boxFaces(box(0, 0));
  const avg = (poly) => poly.reduce((s, p) => s + p.y, 0) / poly.length;
  check('the lid sits above the side faces',
    avg(f.top) < avg(f.right) && avg(f.top) < avg(f.front),
    `top=${avg(f.top).toFixed(1)} right=${avg(f.right).toFixed(1)} front=${avg(f.front).toFixed(1)}`);
}
{
  const lo = boxFaces(box(0, 0, 1, 0));
  const hi = boxFaces(box(0, 0, 1, ISO.LEVEL));
  const avg = (poly) => poly.reduce((s, p) => s + p.y, 0) / poly.length;
  check('a box on the next shelf up draws higher', avg(hi.top) < avg(lo.top));
  check('shelves are exactly LEVEL apart', Math.abs((avg(lo.top) - avg(hi.top)) - ISO.LEVEL) < 1e-9);
}

console.log('\nBoth-sides sections are ONE deep box');
{
  const a = depthFor('A');
  const b = depthFor('B');
  const ab = depthFor('AB');
  check('side A is the front row', a.z === 1 && a.d === 1);
  check('side B is the back row', b.z === 0 && b.d === 1);
  check('side AB is one box, two rows deep', ab.z === 0 && ab.d === 2);
  check('AB starts where B starts and ends where A ends',
    ab.z === b.z && ab.z + ab.d === a.z + a.d);
}
{
  const single = boxFaces(box(0, 0, 1));
  const spanning = boxFaces(box(0, 0, 2));
  const height = (poly) => Math.max(...poly.map((p) => p.y)) - Math.min(...poly.map((p) => p.y));
  check('a two-row box has a visibly deeper lid', height(spanning.top) > height(single.top),
    `${height(single.top).toFixed(1)} → ${height(spanning.top).toFixed(1)}`);
}

console.log('\nShelf layout');
{
  const sec = (i, side) => ({ section_index: i, side });
  const placed = layoutShelf([sec(1, 'A'), sec(2, 'A'), sec(3, 'B')]);
  const at = (i) => placed.find((p) => p.section.section_index === i);
  check('the front row advances on its own', at(1).x === 0 && at(2).x === 1);
  check('the back row starts at zero independently', at(3).x === 0);
  check('rows sit at their own depths', at(1).z === 1 && at(3).z === 0);
}
{
  const sec = (i, side) => ({ section_index: i, side });
  // Front already has two; back has none. The spanning box must clear BOTH.
  const placed = layoutShelf([sec(1, 'A'), sec(2, 'A'), sec(3, 'AB')]);
  const ab = placed.find((p) => p.section.side === 'AB');
  check('a both-sides box is placed clear of both rows', ab.x === 2, String(ab.x));
  check('and it spans two rows', ab.d === 2 && ab.z === 0);
}
{
  const sec = (i, side) => ({ section_index: i, side });
  const placed = layoutShelf([sec(1, 'AB'), sec(2, 'A'), sec(3, 'B')]);
  const at = (i) => placed.find((p) => p.section.section_index === i);
  check('a spanning box consumes a slot in BOTH rows',
    at(1).x === 0 && at(2).x === 1 && at(3).x === 1,
    `AB@${at(1).x} A@${at(2).x} B@${at(3).x}`);
}
{
  const sec = (i, side) => ({ section_index: i, side });
  const placed = layoutShelf([sec(3, 'A'), sec(1, 'A'), sec(2, 'A')]);
  check('layout follows section numbering, not input order',
    placed.map((p) => p.section.section_index).join(',') === '1,2,3');
  check('no two sections in a row share an x',
    new Set(placed.map((p) => p.x)).size === 3);
}
{
  check('an empty shelf lays out to nothing', layoutShelf([]).length === 0);
}

console.log('\nDepth ordering');
{
  // The front row must paint AFTER the back row, or the back would cover it.
  const back = { ...box(0, 0), id: 'back' };
  const front = { ...box(0, 1), id: 'front' };
  const order = paintOrder([front, back]).map((b) => b.id);
  check('the back row is painted first', order.join(',') === 'back,front', order.join(','));
}
{
  const left = { ...box(0, 0), id: 'left' };
  const right = { ...box(3, 0), id: 'right' };
  check('further along the shelf paints later',
    paintOrder([right, left]).map((b) => b.id).join(',') === 'left,right');
}
{
  // A lid that overhangs must not be clipped by the shelf below, so lower draws first.
  const low = { ...box(0, 0, 1, 0), id: 'low' };
  const high = { ...box(0, 0, 1, ISO.LEVEL), id: 'high' };
  check('at the same cell, the lower shelf paints first',
    paintOrder([high, low]).map((b) => b.id).join(',') === 'low,high');
}
{
  check('ordering does not mutate its input', (() => {
    const input = [{ ...box(3, 0), id: 'a' }, { ...box(0, 0), id: 'b' }];
    paintOrder(input);
    return input[0].id === 'a';
  })());
}

console.log('\nRack layout and occlusion');
{
  const s = (shelf, i, side) => ({ shelf_index: shelf, section_index: i, side });
  const boxes = layoutRack([s(1,1,'A'), s(1,2,'B'), s(2,1,'A')], 2);
  check('every section becomes a box', boxes.length === 3);
  check('shelf 2 sits a LEVEL above shelf 1',
    Math.abs(
      boxes.find(b => b.section.shelf_index === 2).baseY -
      boxes.find(b => b.section.shelf_index === 1 && b.section.side === 'A').baseY - ISO.LEVEL,
    ) < 1e-9);
  const front = boxes.find(b => b.section.side === 'A' && b.section.shelf_index === 1);
  const back = boxes.find(b => b.section.side === 'B');
  check('the front row is pushed away from the back row', front.z > back.z + back.d,
    `back ends ${back.z + back.d}, front starts ${front.z}`);
  check('boxes are inset so neighbours do not touch', front.w < 1);
}
{
  const s = (shelf, i, side) => ({ shelf_index: shelf, section_index: i, side });
  const boxes = layoutRack([s(1,1,'AB')], 1);
  check('a spanning box still reaches both rows',
    boxes[0].z < 1 && boxes[0].z + boxes[0].d > 1 + ROW_GAP,
    `${boxes[0].z} → ${boxes[0].z + boxes[0].d}`);
}
{
  // Vertical clearance between shelves, for boxes in the SAME column: an upper box must not
  // reach down onto the lid of the one below it.
  //
  // NOTE this is weaker than it looks and is NOT the whole occlusion story. The failure that
  // actually forced ISO.LEVEL up to 105 was CROSS-column — a spanning box high and to the
  // right swallowed a back-row section low and to the left — and that depends on both x
  // positions, so it is not expressible as a single geometric invariant here. It was found,
  // and the fix confirmed, by rendering the SVG and hit-testing every label with
  // document.elementFromPoint. Treat this check as a floor, not a proof.
  const s = (shelf, i, side) => ({ shelf_index: shelf, section_index: i, side });
  const boxes = layoutRack([s(1,1,'B'), s(2,1,'AB')], 2);
  const lower = boxes.find(b => b.section.shelf_index === 1);
  const upper = boxes.find(b => b.section.shelf_index === 2);

  const lowerLid = boxFaces(lower).top;
  const lidCentreY = (lowerLid[0].y + lowerLid[2].y) / 2;
  const upperLowestY = Math.max(...[
    ...boxFaces(upper).front, ...boxFaces(upper).right,
  ].map(p => p.y));

  check('an upper-shelf box clears the lid of the one directly below',
    upperLowestY < lidCentreY,
    `upper bottom ${upperLowestY.toFixed(1)} vs lower lid ${lidCentreY.toFixed(1)}`);
}

console.log('\nSVG helpers');
{
  const f = boxFaces(box(0, 0));
  const s = toPoints(f.top);
  check('points render as an SVG polygon string', /^[-\d., ]+$/.test(s), s);
  check('a quad yields four coordinate pairs', s.split(' ').length === 4);
  check('coordinates are rounded, not endless floats',
    s.split(' ').every((p) => p.split(',').every((n) => (n.split('.')[1] ?? '').length <= 2)), s);
}
{
  const b = bounds([boxFaces(box(0, 0)).top, boxFaces(box(4, 1)).top]);
  check('bounds span every polygon', b.maxX > b.minX && b.maxY > b.minY,
    `${b.minX},${b.minY} → ${b.maxX},${b.maxY}`);
  const empty = bounds([]);
  check('empty input yields a degenerate, non-NaN box',
    Number.isFinite(empty.minX) && empty.maxX === 0);
}

console.log(`\n${passed} checks passed\n`);
