// Guard on the continuity term — the thing the shadow slate is about.
//
// The failure this exists to catch is a SILENT CUTOVER: someone flips the pOver
// default (or "fixes" the +0.5 in passing) without bumping MODEL_VERSION, and the
// ledger starts blending two pricing conventions with no way to tell them apart
// after the fact. That is unrecoverable — you cannot re-derive which convention a
// stored prob_over came from once both are stamped wnba-v3.
//
// Written to pass in BOTH states, like the gate-override suite: it asserts the
// ledger default and MODEL_VERSION move TOGETHER, not that either has a
// particular value. A legitimate promotion updates the pair below and stays green.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pOver, poissonGTE, MODEL_VERSION, NORMAL_PRICED,
  CONTINUITY_LEDGER, CONTINUITY_CORRECTED, ledgerContinuity,
  writtenContinuity, CONTINUITY_HISTORY,
} from '../wnba-model.mjs';

// The pairing. Update BOTH cells in one commit when the shadow slate ships.
const LEDGER_PRICING_BY_VERSION = {
  'wnba-v3': CONTINUITY_LEDGER,      // legacy double half-step
  'wnba-v4': CONTINUITY_CORRECTED,   // corrected
  'wnba-public-1': CONTINUITY_CORRECTED,
};

test('the live ledger default matches the pricing MODEL_VERSION claims', () => {
  const expected = LEDGER_PRICING_BY_VERSION[MODEL_VERSION];
  assert.notEqual(expected, undefined,
    `MODEL_VERSION ${MODEL_VERSION} has no entry in LEDGER_PRICING_BY_VERSION — add one in the same commit that introduced it.`);
  // pOver's default is what daily-predict.mjs writes, so probe it rather than the constant.
  const proj = 12.0, line = 13.5, sigma = 4.0;
  const written = pOver(proj, line, 'pts', sigma);
  assert.equal(written, pOver(proj, line, 'pts', sigma, expected),
    `pOver's default pricing disagrees with MODEL_VERSION ${MODEL_VERSION}. Flip the default and bump the version together, or the ledger silently blends two conventions.`);
});

test('the two continuity terms actually differ, in the documented direction', () => {
  assert.equal(CONTINUITY_CORRECTED, 0);
  assert.ok(CONTINUITY_LEDGER > CONTINUITY_CORRECTED);
  const p = (c) => pOver(12.0, 13.5, 'pts', 4.0, c);
  // The legacy term shades overs DOWN — that is the whole finding.
  assert.ok(p(CONTINUITY_LEDGER) < p(CONTINUITY_CORRECTED));
});

test('the correction is worth roughly a half-unit of line, not a rounding wobble', () => {
  // proj 2.1 / line 3.5 / sigma 1.44 is the Kelsey Mitchell rebounds row that
  // started this: 9% under the legacy term, ~16% corrected.
  const legacy = pOver(2.1, 3.5, 'reb', 1.44, CONTINUITY_LEDGER);
  const fixed = pOver(2.1, 3.5, 'reb', 1.44, CONTINUITY_CORRECTED);
  assert.ok(Math.abs(legacy - 0.09) < 0.01, `legacy price ${legacy}`);
  assert.ok(Math.abs(fixed - 0.165) < 0.01, `corrected price ${fixed}`);
});

test('Poisson-priced markets ignore the continuity term entirely', () => {
  // fg3m/sb price off P(X >= ceil(line)); this is why they are the control group
  // that isolates the bias to the Normal path. If a continuity term ever leaks in
  // here, the control is gone and the +6.4pp finding loses its comparison.
  for (const stat of ['fg3m', 'sb']) {
    assert.ok(!NORMAL_PRICED.has(stat));
    const a = pOver(2.1, 3.5, stat, 1.44, CONTINUITY_LEDGER);
    const b = pOver(2.1, 3.5, stat, 1.44, CONTINUITY_CORRECTED);
    assert.equal(a, b, `${stat} responded to the continuity term`);
    assert.equal(a, poissonGTE(2.1, 4));
  }
});

test('NORMAL_PRICED is exactly the set the continuity term moves', () => {
  for (const stat of ['pts', 'reb', 'ast', 'pra', 'fg3m', 'sb']) {
    const moves = pOver(12.0, 13.5, stat, 4.0, CONTINUITY_LEDGER)
      !== pOver(12.0, 13.5, stat, 4.0, CONTINUITY_CORRECTED);
    assert.equal(moves, NORMAL_PRICED.has(stat),
      `${stat}: NORMAL_PRICED says ${NORMAL_PRICED.has(stat)} but pricing says ${moves}`);
  }
});

test('ledgerContinuity() reports what pOver actually writes', () => {
  // The promotion gate's pricing freeze keys off this, and self-clears when it
  // flips. If it ever reports the wrong term, the freeze either never lifts or
  // lifts early and lets a prob_min gate ship against a scale about to move.
  const active = ledgerContinuity();
  assert.ok([CONTINUITY_LEDGER, CONTINUITY_CORRECTED].includes(active));
  for (const stat of NORMAL_PRICED) {
    assert.equal(pOver(12.0, 13.5, stat, 4.0), pOver(12.0, 13.5, stat, 4.0, active),
      `ledgerContinuity() says ${active} but ${stat} prices differently by default`);
  }
});

// ── re-scoring history across a cutover ─────────────────────────────────────
// What broke the scheduled job on 2026-08-04: scripts/shadow-pricing.mjs checked
// EVERY stored prob_over against a recompute under CONTINUITY_LEDGER, so the
// first batch of v4 rows to be graded (2026-08-03 games, corrected price) read as
// 0.1768 of drift, the script called the comparison unsound, and the whole
// analyst+gate workflow exited 1 before the gate ever ran. The cutover is not
// drift; a re-score has to price each row with the term it was written with.

test('CONTINUITY_HISTORY ends at whatever pOver writes today', () => {
  // The pairing that stops a repeat. Flip pOver's default without appending a
  // cutover here and every re-score of the new rows reads as drift.
  assert.equal(CONTINUITY_HISTORY.at(-1)[1], ledgerContinuity(),
    'the last CONTINUITY_HISTORY entry disagrees with the live pOver default — append the cutover (date + term) in the commit that flips it.');
});

test('CONTINUITY_HISTORY is an append-only, gap-free timeline', () => {
  assert.equal(CONTINUITY_HISTORY[0][0], '0000-00-00', 'the first entry must cover all dates before the first cutover');
  for (let i = 1; i < CONTINUITY_HISTORY.length; i++) {
    assert.ok(CONTINUITY_HISTORY[i][0] > CONTINUITY_HISTORY[i - 1][0], 'entries must be in ascending date order');
    assert.notEqual(CONTINUITY_HISTORY[i][1], CONTINUITY_HISTORY[i - 1][1], 'an entry that changes nothing is not a cutover');
  }
  for (const [, term] of CONTINUITY_HISTORY)
    assert.ok([CONTINUITY_LEDGER, CONTINUITY_CORRECTED].includes(term));
});

test('writtenContinuity() splits on the cutover date, inclusive', () => {
  const [date, after] = CONTINUITY_HISTORY.at(-1);
  const before = CONTINUITY_HISTORY.at(-2)[1];
  const dayBefore = new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10);
  assert.equal(writtenContinuity(date), after, 'the cutover date itself is priced with the NEW term');
  assert.equal(writtenContinuity(dayBefore), before);
  assert.equal(writtenContinuity('2026-06-25'), CONTINUITY_LEDGER, 'launch-era rows are legacy-priced');
  assert.equal(writtenContinuity(''), CONTINUITY_HISTORY[0][1], 'a missing game_date falls back to the oldest convention, never the newest');
});

test('a real post-cutover row reproduces its stored price, and only under its own term', () => {
  // Naz Hillmon ast 2026-08-03, model_version wnba-v4, stored prob_over 0.5395.
  // This is the row that produced the 0.1768 max drift in the failed run — the
  // largest legacy-vs-corrected gap on the slate, so it is the loudest witness.
  const proj = 1.61, line = 1.5, sigma = 1.11, stored = 0.5395;
  const written = writtenContinuity('2026-08-03');
  assert.ok(Math.abs(pOver(proj, line, 'ast', sigma, written) - stored) < 0.01,
    'the corrected term must reproduce what wnba_picks actually holds for a v4 row');
  assert.ok(Math.abs(pOver(proj, line, 'ast', sigma, CONTINUITY_LEDGER) - stored) > 0.1,
    'and the retired term must NOT — this gap is exactly what a fixed-convention drift check misreads as unsound');
});

test('a real pre-cutover row still reproduces under the legacy term', () => {
  // Kelsey Mitchell reb, priced before the cutover: the other half of the split.
  // If a re-score ever prices history with today's term instead, this fails.
  const proj = 2.1, line = 3.5, sigma = 1.44;
  const stored = pOver(proj, line, 'reb', sigma, CONTINUITY_LEDGER);
  assert.equal(writtenContinuity('2026-07-15'), CONTINUITY_LEDGER);
  assert.ok(Math.abs(pOver(proj, line, 'reb', sigma, writtenContinuity('2026-07-15')) - stored) < 1e-12);
});

test('side selection is what the correction actually puts at risk', () => {
  // A row priced just under 0.5 by the legacy term and just over by the corrected
  // one is the flip class — 26.7% of the book in the retrospective. This asserts
  // the mechanism exists, so a refactor that decouples side from prob_over cannot
  // quietly land without this failing.
  // The flip class is exactly proj in (line, line + 0.5): the legacy term prices it
  // under because it measures to line+0.5, the corrected one prices it over because
  // the projection genuinely clears the line.
  const proj = 13.7, line = 13.5, sigma = 4.0;
  const legacy = pOver(proj, line, 'pts', sigma, CONTINUITY_LEDGER);
  const fixed = pOver(proj, line, 'pts', sigma, CONTINUITY_CORRECTED);
  assert.ok(legacy < 0.5, `legacy ${legacy} should read under`);
  assert.ok(fixed > 0.5, `corrected ${fixed} should read over`);
});
