#!/usr/bin/env node
/**
 * WNBA model scorecard — reads the REAL forward record and tells you where the
 * model is miscalibrated, gated by statistical significance.
 *
 * The other loop halves already exist: daily-predict.mjs RECORDS pre-game picks
 * and GRADES them next day against ESPN box scores. But nothing read the grades
 * back — recalibrate.mjs re-simulates the season from scratch and ignores the
 * accumulated `wnba_picks`. This closes that loop: it consumes the leakage-safe
 * prediction→outcome record and prints exactly what to tune.
 *
 * Unlike recalibrate.mjs (a walk-forward re-simulation), this is the GROUND TRUTH
 * — every row was predicted pre-tip and settled after. Zero Odds API spend; lines
 * are the canonical WNBA_LINES ladder.
 *
 * Every finding carries a VERDICT gated on sample size so you don't overfit to a
 * hot week:
 *   ACTIONABLE  — gap > 2·SE (mean bias |t|>2). Change the constant.
 *   SUGGESTIVE  — gap > 1·SE. Watch it; don't tune yet.
 *   NOISE       — within 1·SE. Ignore.
 *
 * Run:
 *   set -a; source .env.local; set +a
 *   node scripts/calibration-report.mjs            # full scorecard
 *   node scripts/calibration-report.mjs --json     # machine-readable
 *   node scripts/calibration-report.mjs --stat=ast # drill one stat
 */
import { PRIOR_CAL, MODEL_VERSION } from './wnba-model.mjs'; // live App.jsx constants — never drift

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JSON_OUT = process.argv.includes('--json');
const statFilter = process.argv.find(a => a.startsWith('--stat='))?.split('=')[1];
// Model versions co-exist in wnba_picks. Default to the current one so a version bump
// doesn't contaminate the live model's calibration with an older model's record.
// --all reports across every version; --version=X drills a specific one.
const wantAll  = process.argv.includes('--all');
const verArg   = process.argv.find(a => a.startsWith('--version='))?.split('=')[1];
const targetVer = verArg || (wantAll ? null : MODEL_VERSION);

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. `set -a; source .env.local; set +a`');
  process.exit(1);
}

const sbHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

// ── pull every settled pick (hit is non-null → played & graded) ──────────────
// Paginate: PostgREST caps at 1000 rows/response.
async function fetchSettled() {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sbGet(
      `wnba_picks?hit=not.is.null&select=game_date,stat,line,side,projection,prob_over,actual,hit,gp,model_version` +
      `&order=game_date.asc&limit=1000&offset=${offset}`);
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

// ── stats helpers ────────────────────────────────────────────────────────────
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd   = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.map(x => (x - m) ** 2).reduce((x, y) => x + y, 0) / (a.length - 1)); };
const conf = r => Math.max(r.prob_over, 1 - r.prob_over);        // model's stated prob on the side it picked
const won  = r => (r.hit ? 1 : 0);
const pct  = x => (100 * x).toFixed(1) + '%';
const sgn  = x => (x >= 0 ? '+' : '') + x.toFixed(2);

// Verdict for a calibration gap (predicted prob vs realized hit rate over n picks).
function calVerdict(predicted, actual, n) {
  const se = Math.sqrt(Math.max(actual * (1 - actual), 0.01) / n);
  const gap = predicted - actual;                                // +ve = overconfident
  const z = Math.abs(gap) / se;
  const dir = gap > 0 ? 'overconfident' : 'underconfident';
  if (z > 2)  return { tag: 'ACTIONABLE', z, note: `${dir} by ${pct(Math.abs(gap))} (${z.toFixed(1)}σ)` };
  if (z > 1)  return { tag: 'SUGGESTIVE', z, note: `${dir} by ${pct(Math.abs(gap))} (${z.toFixed(1)}σ)` };
  return { tag: 'NOISE', z, note: `within noise (${z.toFixed(1)}σ)` };
}
// Verdict for a mean bias (actual − projection).
function biasVerdict(resids) {
  const n = resids.length, m = mean(resids), s = sd(resids);
  const t = s > 0 ? m / (s / Math.sqrt(n)) : 0;
  const dir = m > 0 ? 'under-projects' : 'over-projects';
  const tag = Math.abs(t) > 2 ? 'ACTIONABLE' : Math.abs(t) > 1 ? 'SUGGESTIVE' : 'NOISE';
  return { m, t, tag, note: `model ${dir} by ${sgn(m)} (t=${t.toFixed(2)})` };
}

// ────────────────────────────────────────────────────────────────────────────
const allRows = await fetchSettled();
if (!allRows.length) { console.log('No settled predictions yet. Let the daily loop run a few nights.'); process.exit(0); }

// Records-by-version breakdown (shown so a bump's before/after is always visible).
const verCounts = {};
for (const r of allRows) { const v = r.model_version || 'unknown'; (verCounts[v] ??= { n: 0, w: 0 }); verCounts[v].n++; if (r.hit) verCounts[v].w++; }

// Scope the analysis to the target version (default = current MODEL_VERSION).
const rows = targetVer ? allRows.filter(r => (r.model_version || 'unknown') === targetVer) : allRows;
if (!rows.length && !JSON_OUT) {
  console.log(`\nSettled picks by model version:`);
  for (const [v, c] of Object.entries(verCounts)) console.log(`  ${v.padEnd(10)} ${c.n} settled (${(100 * c.w / c.n).toFixed(1)}% dir)`);
  console.log(`\nNo settled picks yet for ${targetVer} (the current model). It needs a few nights of graded`);
  console.log(`predictions before its calibration is measurable. Meanwhile: --all reports across every`);
  console.log(`version, --version=<v> drills a past one (e.g. --version=wnba-v1 for the pre-v2 record).\n`);
  process.exit(0);
}
const use = statFilter ? rows.filter(r => r.stat === statFilter) : rows;

const days = [...new Set(rows.map(r => r.game_date))].sort();
const wins = use.filter(won).length, n = use.length;
const brier   = mean(use.map(r => (won(r) - conf(r)) ** 2));
const brierNaive = mean(use.map(r => (won(r) - 0.5) ** 2));      // always-0.5 baseline

// per-stat table (respects --stat)
const STAT_ORDER = ['pts', 'reb', 'ast', 'fg3m', 'pra', 'sb'].filter(s => !statFilter || s === statFilter);
const perStat = {};
for (const s of STAT_ORDER) {
  const g = rows.filter(r => r.stat === s);
  if (!g.length) continue;
  perStat[s] = {
    n: g.length,
    hit: mean(g.map(won)),
    conf: mean(g.map(conf)),
    bias: biasVerdict(g.map(r => r.actual - r.projection)),
    cal: calVerdict(mean(g.map(conf)), mean(g.map(won)), g.length),
  };
}

// calibration curve (confidence buckets)
const edges = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
const buckets = [];
for (let i = 0; i < edges.length - 1; i++) {
  const g = use.filter(r => conf(r) >= edges[i] && conf(r) < edges[i + 1]);
  if (!g.length) continue;
  buckets.push({ lo: edges[i], hi: edges[i + 1], n: g.length, predicted: mean(g.map(conf)), actual: mean(g.map(won)) });
}

// over/under split
const overs = use.filter(r => r.side === 'over'), unders = use.filter(r => r.side === 'under');

const scope = targetVer || 'all-versions';

if (JSON_OUT) {
  console.log(JSON.stringify({ scope, n, wins, days: days.length, brier, brierNaive, perStat, buckets,
    byVersion: verCounts,
    over: { n: overs.length, hit: overs.length ? mean(overs.map(won)) : null },
    under: { n: unders.length, hit: unders.length ? mean(unders.map(won)) : null } }, null, 2));
  process.exit(0);
}

// ── pretty print ─────────────────────────────────────────────────────────────
const bar = '─'.repeat(66);
console.log(`\nWNBA MODEL SCORECARD — live forward record (leakage-safe)`);
console.log(`${days[0]} → ${days.at(-1)}  ·  ${days.length} game-days  ·  ${n} settled picks  ·  model ${scope}${statFilter ? `  ·  stat=${statFilter}` : ''}`);
if (Object.keys(verCounts).length > 1) {
  console.log('  by version: ' + Object.entries(verCounts).map(([v, c]) => `${v} ${c.n} (${(100 * c.w / c.n).toFixed(1)}%)`).join('  ·  ')
    + (targetVer ? `   [showing ${targetVer}; --all for combined]` : ''));
}
console.log(bar);
console.log(`  Record      ${wins}-${n - wins}  (${pct(wins / n)} directional)`);
console.log(`  Brier       ${brier.toFixed(4)}   vs coin-flip ${brierNaive.toFixed(4)}   (lower = better; beating .25 = real edge)`);
console.log(`  Over/Under  over ${overs.length} @ ${overs.length ? pct(mean(overs.map(won))) : '--'}   ·   under ${unders.length} @ ${unders.length ? pct(mean(unders.map(won))) : '--'}`);

console.log(`\n  PER-STAT (hit vs the confidence the model claimed, + mean projection bias)`);
console.log(`  stat  n    hit     conf    Δcal    calibration            projection bias`);
for (const s of STAT_ORDER) {
  const d = perStat[s]; if (!d) continue;
  const dcal = d.conf - d.hit;
  console.log(
    `  ${s.padEnd(4)} ${String(d.n).padStart(3)}  ${pct(d.hit).padStart(6)}  ${pct(d.conf).padStart(6)}  ` +
    `${sgn(dcal).padStart(6)}  ${(d.cal.tag).padEnd(10)} ${d.cal.note.padEnd(11)}  ${d.bias.tag.padEnd(10)} ${d.bias.note}`);
}

console.log(`\n  CALIBRATION CURVE (does stated prob match reality?)`);
console.log(`  confidence     n     predicted   actual    gap`);
for (const b of buckets) {
  const gap = b.predicted - b.actual;
  console.log(`  ${b.lo.toFixed(2)}-${b.hi > 1 ? '1.00' : b.hi.toFixed(2)}   ${String(b.n).padStart(4)}    ${pct(b.predicted).padStart(6)}     ${pct(b.actual).padStart(6)}   ${sgn(gap).padStart(6)}`);
}

// ── recommendations: only surface findings past the significance gate ────────
console.log(`\n  VERDICT`);
const recs = [];
for (const s of STAT_ORDER) {
  const d = perStat[s]; if (!d) continue;
  if (d.cal.tag === 'ACTIONABLE') {
    const dir = d.conf > d.hit ? 'RAISE' : 'LOWER';
    recs.push(`${dir} SIGMA_COEFF.${s} — ${d.cal.note} over ${d.n} picks (widen→less confident / narrow→more).`);
  }
  if (d.bias.tag === 'ACTIONABLE') {
    const mult = perStatMult(s, rows);
    recs.push(`ADJUST PRIOR_CAL.${s} toward ~${mult.toFixed(2)} — ${d.bias.note} over ${d.n} picks. ` +
      `(Conservative start: the prior is only part of the blend, so nudge and re-measure.)`);
  }
}
if (recs.length) recs.forEach(r => console.log('   • ' + r));
else {
  const susp = [];
  for (const s of STAT_ORDER) { const d = perStat[s]; if (!d) continue;
    if (d.cal.tag === 'SUGGESTIVE') susp.push(`${s} cal (${d.cal.note})`);
    if (d.bias.tag === 'SUGGESTIVE') susp.push(`${s} bias (${d.bias.note})`);
  }
  console.log('   No change crosses the 2σ significance gate yet — do not re-tune constants.');
  if (susp.length) console.log('   Watching (1-2σ, needs more nights): ' + susp.join(', ') + '.');
}
console.log(`\n  (Report-only. Edit SIGMA_COEFF / PRIOR_CAL in src/App.jsx by hand; wnba-model.mjs reads them live.)\n`);

// Suggested PRIOR_CAL multiplier to neutralize a mean bias for one stat.
// Scales the CURRENT cal by the realized actual/projection ratio. This is a
// conservative first step: at median gp (~17) the prior is only ~half the blend,
// so fully closing the gap through the prior alone would need a bigger move —
// nudge, let a week of picks settle, re-run.
function perStatMult(stat, all) {
  const g = all.filter(r => r.stat === stat);
  const a = mean(g.map(r => r.actual)), p = mean(g.map(r => r.projection));
  const cur = PRIOR_CAL[stat] ?? 1;
  return p > 0 ? cur * (a / p) : cur;
}
