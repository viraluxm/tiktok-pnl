import { readFileSync } from 'node:fs';
import ts from 'typescript';

const src = readFileSync(new URL('./printRetry.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);
const { MAX_SLICE_TRIES, isRetryableStatus, retryWaitMs, shouldRetry } = mod;

let fails = 0;
const check = (name, cond) => { if (!cond) { console.error(`FAIL ${name}`); fails++; } else console.log(`ok   ${name}`); };

// ── which statuses are transient ──
check('504 gateway timeout retries', isRetryableStatus(504) === true);
check('502 retries', isRetryableStatus(502) === true);
check('500 retries', isRetryableStatus(500) === true);
check('dropped connection (0) retries', isRetryableStatus(0) === true);

// A 4xx is a decision about the run. Retrying it only delays an error the operator must read.
check('404 does NOT retry', isRetryableStatus(404) === false);
check('409 nothing-printable does NOT retry', isRetryableStatus(409) === false);
check('401 signed-out does NOT retry', isRetryableStatus(401) === false);
check('200 does NOT retry', isRetryableStatus(200) === false);

// ── the attempt budget is finite ──
check('first failure may retry', shouldRetry(1, 504) === true);
check('second failure may retry', shouldRetry(2, 504) === true);
check(`attempt ${MAX_SLICE_TRIES} is the last`, shouldRetry(MAX_SLICE_TRIES, 504) === false);
check('budget cannot be exceeded', shouldRetry(MAX_SLICE_TRIES + 5, 504) === false);
// Both conditions must hold, not either.
check('a 4xx on attempt 1 still does not retry', shouldRetry(1, 404) === false);

// ── waits grow, and are bounded ──
check('wait grows', retryWaitMs(2) > retryWaitMs(1));
check('wait is finite past the ladder', Number.isFinite(retryWaitMs(99)));
const worst = Array.from({ length: MAX_SLICE_TRIES - 1 }, (_, i) => retryWaitMs(i + 1))
  .reduce((a, b) => a + b, 0);
check(`worst-case wait per slice is bounded (${worst}ms <= 15s)`, worst <= 15_000);
check('no zero/negative wait', retryWaitMs(1) > 0);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
