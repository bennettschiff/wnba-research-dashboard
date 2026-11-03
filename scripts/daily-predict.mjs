#!/usr/bin/env node
/**
 * WNBA daily model loop — runs once a day (GitHub Actions cron).
 *
 *   1. GRADE  every ungraded past prediction against the realized ESPN box score.
 *   2. PREDICT today's slate: for each projected player whose team plays today,
 *      run the live model (same math as src/App.jsx) and record its pick vs the
 *      standard prop line into Supabase `wnba_picks`.
 *
 * The point: accumulate a forward, leakage-safe prediction→outcome record so we
 * can measure calibration and finetune SIGMA_COEFF / PRIOR_CAL over the season —
 * the same closing-the-loop substrate the MLB lab built, but with ZERO Odds API
 * spend (lines are the canonical WNBA_LINES ladder).
 *
 * Local run:
 *   set -a; source .env.local; set +a
 *   node scripts/daily-predict.mjs            # predict today + grade past
 *   node scripts/daily-predict.mjs --dry-run  # print, don't write
 *   node scripts/daily-predict.mjs --date=20260625   # predict a specific day
 *   node scripts/daily-predict.mjs --grade-only      # grade past, write no new picks
 */
import {
  PROJ, STATS, MIN_GAMES, MODEL_VERSION, FALLBACK_MODEL_VERSION,
  normalizeName, predictStat, collectLogs, fetchSchedule, fetchAdvancedContext,
  mergeRoster,
} from './wnba-model.mjs';
import { isOfficialPick } from './lib/official-pick.mjs';
import { activeOverrides, activeGlobals } from './lib/gate-overrides.mjs';
import { sbFetch } from './lib/sb-fetch.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.argv.includes('--dry-run');
const GRADE_ONLY = process.argv.includes('--grade-only');
const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1];

if ((!SUPABASE_URL || !SERVICE_KEY) && !DRY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (use --dry-run to test without writes)');
  process.exit(1);
}

const SEASON_START = new Date(Date.UTC(new Date().getUTCFullYear(), 4, 8, 12)); // May 8
const statVal = Object.fromEntries(STATS.map(s => [s.id, s.val]));

// ── date helpers (ET — WNBA games are evening ET) ───────────────────────────
const etNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const ymd   = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const iso   = ymdStr => `${ymdStr.slice(0,4)}-${ymdStr.slice(4,6)}-${ymdStr.slice(6,8)}`;

const today = dateArg || ymd(etNow());
const yesterday = (() => { const d = etNow(); d.setUTCDate(d.getUTCDate() - 1); return ymd(d); })();

// ── Supabase REST helpers ───────────────────────────────────────────────────
const sbHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
async function sbGet(path) {
  const r = await sbFetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbUpsert(rows) {
  // on_conflict must name the unique constraint's columns — merge-duplicates alone
  // only resolves on the PK, so a re-run hit wnba_picks_game_date_player_norm_stat_key
  // with a 409 (e.g. manual run + scheduled run on the same day).
  const r = await sbFetch(`${SUPABASE_URL}/rest/v1/wnba_picks?on_conflict=game_date,player_norm,stat`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`upsert → ${r.status} ${await r.text()}`);
}
async function sbPatch(id, patch) {
  const r = await sbFetch(`${SUPABASE_URL}/rest/v1/wnba_picks?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`patch ${id} → ${r.status} ${await r.text()}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log(`WNBA daily loop — today ${iso(today)} (ET)`);
console.log('Pulling ESPN box scores…');
const { logs, games, roster: liveRoster } = await collectLogs(SEASON_START, etNow());
console.log(`  ${games} finished games, ${Object.keys(logs).length} players with logs\n`);

// ── 1. GRADE past ungraded predictions ──────────────────────────────────────
async function grade() {
  if (DRY) { console.log('── GRADE (dry-run skips DB read) ──\n'); return; }
  const pending = await sbGet(`wnba_picks?graded_at=is.null&game_date=lte.${iso(yesterday)}&select=id,game_date,player_norm,stat,line,side&limit=5000`);
  console.log(`── GRADE — ${pending.length} ungraded predictions on/before ${iso(yesterday)} ──`);
  let graded = 0, missing = 0;
  for (const row of pending) {
    const log = logs[row.player_norm];
    const ymdDate = row.game_date.replace(/-/g, '');
    const g = log?.find(x => x.date === ymdDate);
    if (!g) {
      // No box score for that player/date = DNP or postponed. Settle as void (hit=null).
      missing++;
      await sbPatch(row.id, { actual: null, hit: null, graded_at: new Date().toISOString() });
      continue;
    }
    const actual = statVal[row.stat](g);
    const wentOver = actual >= Number(row.line);
    const hit = row.side === 'over' ? wentOver : !wentOver;
    await sbPatch(row.id, { actual, hit, graded_at: new Date().toISOString() });
    graded++;
  }
  console.log(`  graded ${graded}, voided ${missing} (DNP/no box score)\n`);
}
await grade();

// ── 1b. ROLLING SCORECARD — read the graded record back (closes the loop) ────
// The whole point of recording predictions is to see how they go. Print a compact
// season-to-date record every run so the Actions log shows model health at a glance;
// `node scripts/calibration-report.mjs` gives the full per-stat / calibration drill.
async function scorecard() {
  if (DRY) return;
  // Paginate: PostgREST silently caps any single response at 1000 rows.
  const settled = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sbGet(`wnba_picks?hit=not.is.null&select=prob_over,hit,model_version&limit=1000&offset=${offset}`);
    settled.push(...page);
    if (page.length < 1000) break;
  }
  if (!settled.length) { console.log('── SCORECARD — no settled picks yet ──\n'); return; }
  const conf = r => Math.max(r.prob_over, 1 - r.prob_over);
  const line = (rows, label) => {
    const n = rows.length, wins = rows.filter(r => r.hit).length;
    const brier = rows.reduce((a, r) => a + ((r.hit ? 1 : 0) - conf(r)) ** 2, 0) / n;
    const hi = rows.filter(r => conf(r) >= 0.65);
    const hiHit = hi.length ? hi.filter(r => r.hit).length / hi.length : null;
    return `  ${label}  ${wins}-${n - wins} (${(100 * wins / n).toFixed(1)}% dir)  ·  Brier ${brier.toFixed(4)} vs .2500  ·  ` +
      `hi-conf ≥65%: ${hi.length ? (100 * hiHit).toFixed(1) + '% (' + hi.length + ')' : 'n/a'}`;
  };
  // Report the live model's record separately from any older-version history so a
  // MODEL_VERSION bump doesn't muddy the current model's calibration.
  const cur = settled.filter(r => (r.model_version || '') === MODEL_VERSION);
  console.log(`── SCORECARD (season-to-date, leakage-safe) ──`);
  console.log(line(settled, 'all versions: '));
  if (cur.length && cur.length !== settled.length) console.log(line(cur, `${MODEL_VERSION} only:  `));
  console.log('');
}
await scorecard();

// --grade-only stops here, before any new picks are written. This exists for the
// lab-analyst-wnba routine: it wakes at 4:50 AM ET expecting daily-predict.yml to
// have graded yesterday at 3:45, but GitHub's scheduler delays scheduled runs by
// an unbounded amount (2026-07-21: 2h20m late, so the analyst found 275 ungraded
// rows, had no new data, and correctly skipped its whole panel — a lost day).
// grade() only touches rows with graded_at IS NULL, so this is idempotent and
// safe to run alongside the real pass: whoever gets there first does the work.
// Grading only, never predicting, is the point — two processes writing today's
// slate would double-record it.
if (GRADE_ONLY) {
  console.log('--grade-only: stopping before PREDICT.');
  process.exit(0);
}

// ── 2. PREDICT today's slate ────────────────────────────────────────────────
console.log(`── PREDICT — slate for ${iso(today)} ──`);
const schedule = await fetchSchedule(today);
const live = schedule.filter(g => g.state !== 'post'); // don't predict already-final games
if (!live.length) { console.log('  No upcoming games today. Done.'); process.exit(0); }

// team → upcoming-game context
const ctx = {};
for (const g of live) {
  if (g.home) ctx[g.home] = { opp: g.away, home: true,  espnGameId: g.id };
  if (g.away) ctx[g.away] = { opp: g.home, home: false, espnGameId: g.id };
}
console.log(`  ${live.length} games, ${Object.keys(ctx).length} teams`);

// Advanced layer (stats.wnba.com + AWS gravity) — v3 factors. If the sources are
// unreachable tonight, predict with v2 math and record that version honestly.
console.log('  Pulling advanced layer (team defense, pace, scoring profiles, gravity)…');
const { ctx: advCtx, complete: advComplete, source: advSource } = await fetchAdvancedContext(String(new Date().getUTCFullYear()), logs);
const modelVersion = advComplete ? MODEL_VERSION : FALLBACK_MODEL_VERSION;
console.log(`  advanced layer ${advComplete ? `loaded (${advSource})` : 'UNAVAILABLE — falling back to v2 math'}: ` +
  `${Object.keys(advCtx.teamOpponent).length} team-def rows, ${Object.keys(advCtx.gravity).length} gravity players → ${modelVersion}`);

// Merge the live roster (derived from the ESPN box-score logs above) into the frozen
// PROJ seed so rotation players it missed (trades, rookies, 2026 expansion signings)
// still get picks written — otherwise they never reach wnba_picks / feed / lab / gate.
// If no games have been played the merge is a no-op (returns PROJ unchanged).
const roster = mergeRoster(PROJ, liveRoster);
const added = roster.length - PROJ.length;
console.log(`  roster: ${PROJ.length} seed${added > 0 ? ` + ${added} live-roster additions` : ' (no live-roster additions)'} = ${roster.length} players`);

const rows = [];
for (const p of roster) {
  const upcoming = ctx[p.t];
  if (!upcoming) continue;
  const norm = normalizeName(p.n);
  const priorLogs = logs[norm] || [];
  if (priorLogs.length < MIN_GAMES) continue;

  for (const s of STATS) {
    const pred = predictStat(priorLogs, p, s, upcoming, advComplete ? advCtx : null);
    if (!pred) continue;
    const row = {
      game_date: iso(today),
      espn_game_id: upcoming.espnGameId,
      player: p.n,
      player_norm: norm,
      team: p.t,
      opp: upcoming.opp,
      is_home: upcoming.home,
      stat: s.id,
      line: pred.line,
      projection: pred.projection,
      prob_over: pred.probOver,
      side: pred.side,
      sigma: pred.sigma,
      gp: pred.gp,
      gravity: pred.gravity,
      mate_gravity: pred.mateGravity,
      sigma_profile: pred.sigmaProfile,
      model_version: modelVersion,
    };
    // THE PROMOTION-GATE SURFACE. The row is written either way — this only
    // stamps whether it cleared the promoted lab gates. See lib/official-pick.mjs
    // for why this gates a flag and not the write: wnba_picks is the lab's own
    // input, so suppressing rows would both starve the analyst and let the
    // gate's retention check grade a feed it had already thinned.
    row.is_official = isOfficialPick(row);
    rows.push(row);
  }
}

const players = new Set(rows.map(r => r.player_norm)).size;
const official = rows.filter(r => r.is_official).length;
console.log(`  ${rows.length} predictions across ${players} players`);

// Say what the gate did, every run. A promoted gate that silently stops passing
// picks is the failure mode this whole apparatus exists to catch, so the number
// it gated has to be visible in the Actions log — not just in the lab reports.
const gates = activeOverrides(), globals = activeGlobals();
if (gates.length || globals.length) {
  const desc = [
    ...globals.map(g => `${g.key}=${g.value}`),
    ...gates.map(g => `${g.market}[${Object.entries(g.params).map(([k, v]) => `${k}=${v}`).join(',')}]`),
  ].join(' ');
  console.log(`  promoted lab gates active: ${desc}`);
  console.log(`  official ${official}/${rows.length} (${rows.length - official} gated out, still saved & still on the board)`);
} else {
  console.log(`  official ${official}/${rows.length} (no promoted lab gates active)`);
}

if (DRY) {
  const top = rows.filter(r => Math.abs(r.prob_over - 0.5) >= 0.2)
    .sort((a, b) => Math.abs(b.prob_over - 0.5) - Math.abs(a.prob_over - 0.5)).slice(0, 15);
  console.log('\n  Strongest leans (dry-run, not written):');
  for (const r of top) console.log(`   ${r.player.padEnd(22)} ${r.stat.padEnd(4)} ${r.side.toUpperCase().padEnd(5)} ${r.line}  p=${r.prob_over}  proj=${r.projection}`);
  console.log('\n  (--dry-run: nothing written.)');
  process.exit(0);
}

if (rows.length) await sbUpsert(rows);
console.log(`  upserted ${rows.length} predictions into wnba_picks. Done.`);
