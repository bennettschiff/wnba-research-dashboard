// Version pin on the price itself.
//
// lib/pricing.test.mjs pins the CONTINUITY TERM to MODEL_VERSION. This pins the
// whole score→probability mapping, so any other change to pOver — a sigma floor,
// a Poisson branch, a clamp — is caught the same way the continuity term is.
//
// THE FAILURE THIS EXISTS TO CATCH: a price moves while MODEL_VERSION stays put,
// so two pricing conventions end up stamped with the same tag in wnba_picks.
// Nothing in the row records which one priced it, so it is unrecoverable after
// the fact, and every consumer that stratifies on model_version is quietly
// blended — daily-predict.mjs's own calibration line and
// calibration-report.mjs both scope on an exact match.
//
// The mirror-image mistake already cost a workflow: on 2026-08-04 the pricing
// slate re-scored history under a single convention, read the SHIPPED
// 2026-08-03 cutover as 0.1768 of drift, declared itself UNSOUND and failed the
// analyst + gate job before either could run. Both directions come from the same
// root — the price changing without the version being able to prove it.
//
// WHEN THIS FAILS:
//   - a digest moved  → you changed pOver. Bump MODEL_VERSION and re-pin the
//     digest here in the same commit. If you changed the continuity term, append
//     to CONTINUITY_HISTORY too (lib/pricing.test.mjs enforces that half).
//   - the version pin moved → you bumped the version. If the digests still match,
//     the STATS math changed but the price did not: sync the names below. Making
//     that a conscious step is the point.
//
// BOTH TIERS ARE PINNED, on purpose. The 2026-08-03 cutover bumped MODEL_VERSION
// v3→v4 AND FALLBACK_MODEL_VERSION v2→v3 together, which is exactly what made
// 'wnba-v3' ambiguous — the old convention on a pre-cutover row, the new one on a
// post-cutover fallback row. That ambiguity is why writtenContinuity() has to key
// on game_date instead of model_version. Recording both names here keeps the
// pairing explicit instead of leaving it to be rediscovered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pOver, STATS, MODEL_VERSION, FALLBACK_MODEL_VERSION } from '../wnba-model.mjs';

// The version names these digests were taken at. Both cells, one commit.
const VERSION_PIN = { model: 'wnba-public-1', fallback: 'wnba-public-0' };

// proj × line × sigma per stat. Lines are real LINES entries; projections
// straddle each line, including the flip class (proj just over the line, e.g.
// pts 13.7 on 13.5) where the continuity term decides the SIDE and not just the
// price. Append to a grid freely — that re-pins the digest. Never narrow one:
// that blinds the guard to the range removed.
//
// The 0.3 sigma is load-bearing: it sits BELOW pOver's `Math.max(sig, 0.5)`
// floor, so the floor is actually exercised. The first draft of this grid
// started at 0.8 and a 0.5→0.6 floor change moved no digest at all — a pin whose
// grid never reaches a constant does not guard that constant. Poisson stats take
// no sigma, so they carry one nominal value rather than a floor probe.
const GRID = {
  pts:  { lines: [7.5, 13.5, 19.5, 25.5], projs: [6.0, 12.0, 13.7, 20.0],  sigmas: [0.3, 2.5, 4.0, 6.5] },
  reb:  { lines: [3.5, 5.5, 8.5],         projs: [2.1, 4.0, 6.0, 9.0],     sigmas: [0.3, 1.2, 1.44, 3.0] },
  ast:  { lines: [1.5, 3.5, 6.5],         projs: [1.1, 1.61, 4.0, 7.0],    sigmas: [0.3, 1.0, 1.11, 2.2] },
  pra:  { lines: [13.5, 21.5, 29.5],      projs: [12.0, 20.0, 22.3, 31.0], sigmas: [0.3, 3.5, 5.5, 8.0] },
  fg3m: { lines: [0.5, 1.5, 2.5, 3.5],    projs: [0.4, 1.2, 2.0, 3.1],     sigmas: [1.5] },
  sb:   { lines: [1.5, 2.5, 3.5],         projs: [0.9, 1.6, 2.4, 3.3],     sigmas: [1.5] },
};

const PINS = {
  pts:  '49884a1471ef0307',
  reb:  '7152b0293b31c2f1',
  ast:  'df681fc812065383',
  pra:  '678e7539cb7f960f',
  fg3m: 'e415ad4912703f46',
  sb:   '46c7a33fa924ca33',
};

// Deliberately calls pOver with its DEFAULT continuity term — the digest must
// fingerprint what daily-predict.mjs actually writes, not a term named here.
function digest(id, perturb = null) {
  const { lines, projs, sigmas } = GRID[id];
  const parts = [];
  for (const proj of projs) for (const line of lines) for (const sig of sigmas) {
    const p = pOver(proj, line, id, sig);
    parts.push(`${proj}|${line}|${sig}|${perturb && perturb(proj, line, sig) ? p + 1e-9 : p}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

for (const id of Object.keys(GRID)) {
  test(`${id}: pOver matches the pinned digest`, () => {
    assert.equal(digest(id), PINS[id],
      `pOver moved for ${id}. Bump MODEL_VERSION and re-pin this digest in the same commit — a price change the version cannot prove is unrecoverable once it is in wnba_picks.`);
  });
}

test('the pin is taken at the live MODEL_VERSION, both tiers', () => {
  assert.equal(VERSION_PIN.model, MODEL_VERSION,
    'MODEL_VERSION moved. If every digest above still passes the price did not change — sync the name here.');
  assert.equal(VERSION_PIN.fallback, FALLBACK_MODEL_VERSION,
    'FALLBACK_MODEL_VERSION moved. The tiers bump together; leaving one behind is what makes a version tag mean two different prices.');
});

test('every priced stat is pinned', () => {
  // A stat added to STATS is unguarded until it is pinned. Silence is not a
  // decision here — this fails until someone makes one.
  const priced = STATS.map(s => s.id).sort();
  assert.deepEqual(Object.keys(GRID).sort(), priced);
  assert.deepEqual(Object.keys(PINS).sort(), priced);
});

test('the digest actually responds to a price change', () => {
  // Guards the guard: a fingerprint that cannot move reads as coverage while
  // providing none. Perturb one grid point by 1e-9 and require a different hash.
  const moved = digest('reb', (proj, line) => proj === 4.0 && line === 5.5);
  assert.notEqual(moved, PINS.reb);
});

test('pOver is implemented exactly once in the repo', () => {
  // The pin can only guard the copy it imports. scripts/recalibrate.mjs used to
  // carry its own pOver with the continuity term hardcoded to the legacy +0.5,
  // so it kept pricing with the retired convention after the 2026-08-03 cutover
  // and its SIGMA_COEFF / PRIOR_CAL suggestions were measured against a price
  // the board no longer uses. One implementation, or the pin is theatre.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.mjs') || full.endsWith('wnba-model.mjs')) continue;
      if (/function\s+pOver\s*\(/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(dir, full));
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [],
    `these files define their own pOver instead of importing it from wnba-model.mjs: ${offenders.join(', ')}. A second copy does not get the next cutover.`);
});
