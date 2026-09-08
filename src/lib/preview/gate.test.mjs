// The preview route must NEVER be reachable on the production domain — including the case where
// this branch is merged to main by accident, which is the whole reason the gate exists.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'previewgate-'));
const src = fileURLToPath(new URL('./gate.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(src, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const out = join(dir, 'gate.mjs');
writeFileSync(out, outputText);
const { isPreviewRouteAllowed } = await import(pathToFileURL(out).href);

let passed = 0;
const check = (n, c) => { assert.ok(c, `FAIL: ${n}`); console.log(`  ✓ ${n}`); passed++; };

console.log('\nPHASE 2 PREVIEW ROUTE GATE');

// THE ONE THAT MATTERS. Everything else is convenience; this is the safety property.
check('Vercel PRODUCTION is denied', isPreviewRouteAllowed({ VERCEL_ENV: 'production', NODE_ENV: 'production' }) === false);
check('… denied even if NODE_ENV says development', isPreviewRouteAllowed({ VERCEL_ENV: 'production', NODE_ENV: 'development' }) === false);

// The reviewer's actual environment: a Vercel Preview is a PRODUCTION Next build.
check('Vercel PREVIEW is allowed', isPreviewRouteAllowed({ VERCEL_ENV: 'preview', NODE_ENV: 'production' }) === true);
check('vercel dev is allowed', isPreviewRouteAllowed({ VERCEL_ENV: 'development', NODE_ENV: 'development' }) === true);

// Local npm run dev — no VERCEL_ENV at all.
check('local dev (no VERCEL_ENV) is allowed', isPreviewRouteAllowed({ NODE_ENV: 'development' }) === true);
check('local production build (no VERCEL_ENV) is DENIED', isPreviewRouteAllowed({ NODE_ENV: 'production' }) === false);

// Fail CLOSED: anything unrecognised denies, so a future platform change cannot open the route.
check('unknown VERCEL_ENV denies', isPreviewRouteAllowed({ VERCEL_ENV: 'staging', NODE_ENV: 'production' }) === false);
check('empty VERCEL_ENV falls back to NODE_ENV', isPreviewRouteAllowed({ VERCEL_ENV: '', NODE_ENV: 'production' }) === false);
check('completely empty env denies under production', isPreviewRouteAllowed({ NODE_ENV: 'production' }) === false);
check('no keys at all is allowed (undefined NODE_ENV = not production)', isPreviewRouteAllowed({}) === true);

// The route file must actually USE the gate and notFound() — a gate nobody calls is decoration.
const routeSrc = readFileSync(fileURLToPath(new URL('../../app/preview/schedule-phase2/page.tsx', import.meta.url)), 'utf8');
const code = routeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
check('the route imports the gate', /isPreviewRouteAllowed/.test(code));
check('the route calls notFound() when denied', /if\s*\(!isPreviewRouteAllowed\(\)\)\s*notFound\(\)/.test(code));

// And it must never touch Supabase.
check('the route imports no Supabase client', !/supabase/i.test(code));

console.log(`\n${passed} checks passed`);
