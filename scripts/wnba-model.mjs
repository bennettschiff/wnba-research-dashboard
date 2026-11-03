// Shared WNBA model math + data pulls.
// Single source of truth for both recalibrate.mjs (backtest) and daily-predict.mjs
// (forward prediction). The math here MIRRORS buildWNBAModel in src/App.jsx — the
// live constants (PROJ_2026, SIGMA_COEFF, SIGMA_FLOOR, PRIOR_CAL) are extracted
// straight from App.jsx so this file never drifts from the UI model.
//
// No deps, no keys, Node 18+ (global fetch). ESPN public endpoints only — zero
// Odds API spend.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'src/App.jsx'), 'utf8');

// ── live constants pulled from App.jsx ──────────────────────────────────────
export const PROJ = eval('[' + APP.match(/const PROJ_2026 = \[([\s\S]*?)\n\];/)[1] + ']');
export const SIGMA_COEFF = eval('(' + APP.match(/const SIGMA_COEFF = (\{[^}]*\})/)[1] + ')');
export const SIGMA_FLOOR = eval('(' + APP.match(/const SIGMA_FLOOR = (\{[^}]*\})/)[1] + ')');
export const PRIOR_CAL = (() => { const m = APP.match(/const PRIOR_CAL = (\{[^}]*\})/); return m ? eval('(' + m[1] + ')') : {}; })();

// Bump when the model math changes; every pick row records the version that ran.
// (Public build: placeholder versions; production history is private.)
export const MODEL_VERSION = 'wnba-public-1';
export const FALLBACK_MODEL_VERSION = 'wnba-public-0';

// ── primitives (mirror App.jsx) ─────────────────────────────────────────────
export function normalCDF(z){const s=z<0?-1:1;const x=Math.abs(z)/Math.SQRT2;const t=1/(1+0.3275911*x);const y=1-t*(0.254829592+t*(-0.284496736+t*(1.421413741+t*(-1.453152027+t*1.061405429))))*Math.exp(-x*x);return(1+s*y)/2;}
export function poissonGTE(l,k){if(l<=0)return k<=0?1:0;const F=[1,1,2,6,24,120,720,5040,40320,362880];let c=0;for(let i=0;i<Math.min(k,20);i++)c+=Math.pow(l,i)*Math.exp(-l)/(i<F.length?F[i]:F.at(-1));return Math.max(0,Math.min(1,1-c));}
export function sd(a){if(!a||a.length<3)return null;const m=a.reduce((x,y)=>x+y,0)/a.length;return Math.sqrt(a.map(x=>(x-m)**2).reduce((x,y)=>x+y,0)/(a.length-1));}
export const clampMult=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));

// Recency-weighted mean over a CHRONOLOGICAL (oldest→newest) array. Exponential
// half-life of RECENCY_HL games so recent form/role dominates. Mirrors App.jsx.
export const RECENCY_HL = 8;
export function recencyMean(vals){const n=vals?.length??0;if(!n)return null;let sw=0,swv=0;for(let i=0;i<n;i++){const w=Math.pow(0.5,(n-1-i)/RECENCY_HL);sw+=w;swv+=w*vals[i];}return swv/sw;}
export const normalizeName = n => (n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

export const LINES = { pts:[7.5,9.5,11.5,13.5,15.5,17.5,19.5,21.5,23.5,25.5,27.5], reb:[3.5,4.5,5.5,6.5,7.5,8.5,9.5,10.5,11.5,12.5], ast:[1.5,2.5,3.5,4.5,5.5,6.5,7.5,8.5], fg3m:[0.5,1.5,2.5,3.5], pra:[13.5,15.5,17.5,19.5,21.5,23.5,25.5,27.5,29.5,31.5,33.5,35.5], sb:[1.5,2.5,3.5] };
export const STATS = [
  { id:'pts',  val:g=>g.pts,               prior:p=>p.pts,                normal:true  },
  { id:'reb',  val:g=>g.reb,               prior:p=>p.reb,                normal:true  },
  { id:'ast',  val:g=>g.ast,               prior:p=>p.ast,                normal:true  },
  { id:'fg3m', val:g=>g.fg3m,              prior:p=>p.fg3m,               normal:false },
  { id:'pra',  val:g=>g.pts+g.reb+g.ast,   prior:p=>p.pts+p.reb+p.ast,    normal:true  },
  { id:'sb',   val:g=>g.stl+g.blk,         prior:p=>p.stl+p.blk,          normal:false },
];
export const REGRESSION_N = 12, MIN_GAMES = 3, SIG_K = 12;

// ── THE CONTINUITY TERM (read before touching pOver) ────────────────────────
// For a count stat on an X.5 line, "over 3.5" and ">= 4" are the SAME event, so
// the continuity-corrected Normal price is 1 - Phi((line - proj)/sigma). Shipping
// `line + 0.5` applies the half-step twice and shades every over down / every
// under up. Measured on 4,726 graded picks (2026-06-25 -> 2026-08-01):
//
//   Normal path (pts/reb/ast/pra)   predicted P(over) 37.7%  realized 44.0%  +6.4pp
//   Poisson path (fg3m/sb)          predicted P(over) 38.5%  realized 39.7%  +1.2pp
//
// The Poisson path never applies the term and is calibrated; every Normal stat is
// off in the same direction by about the half-unit. Re-pricing the same rows with
// CONTINUITY_CORRECTED moves mean predicted P(over) 37.6% -> 43.9% against a 44.0%
// realized rate (Brier 0.2298 -> 0.2276).
//
// The correction ran in shadow (not live) from 2026-07-02 through 2026-08-02: it
// flips the chosen side on ~27% of picks, and lab/README.md's rule is that
// nothing reaches live selection without a forward-scored shadow slate proving
// the flipped side actually wins more. It did: the OOS shadow slate matured
// 2026-08-03 at 62 flipped picks (SHIP verdict, +30.55u delta, better
// calibrated — see lab/shadow-pricing/2026-08-03.md), so this is now the
// default pOver uses.
//
//   CONTINUITY_LEDGER     the old convention (pre-2026-08-03 wnba_picks rows)
//   CONTINUITY_CORRECTED  what daily-predict.mjs writes now and what the
//                         dashboard displays — promoted together with the
//                         MODEL_VERSION bump above, never one without the other,
//                         or calibration blends two conventions.
export const CONTINUITY_LEDGER = 0.5;
export const CONTINUITY_CORRECTED = 0;

export function pOver(proj, line, id, sig, continuity = CONTINUITY_CORRECTED) {
  if (!proj || proj <= 0) return null;
  // Poisson counts are priced off P(X >= ceil(line)) and take no continuity term.
  if (id === 'fg3m' || id === 'sb') return poissonGTE(proj, Math.ceil(line));
  return Math.max(0, Math.min(1, 1 - normalCDF((line + continuity - proj) / Math.max(sig, 0.5))));
}

// Stats priced through the Normal path — the only ones the continuity term touches.
export const NORMAL_PRICED = new Set(['pts', 'reb', 'ast', 'pra']);

// Which continuity term pOver ACTUALLY writes with right now. Probed rather than
// declared, so it can never disagree with the default above — and so the pricing
// slate's consumers (the promotion gate's CHECK 3b) self-clear the moment the
// cutover lands, instead of depending on someone remembering to flip a flag.
export function ledgerContinuity() {
  const probe = pOver(12.0, 13.5, 'pts', 4.0);
  return probe === pOver(12.0, 13.5, 'pts', 4.0, CONTINUITY_CORRECTED)
    ? CONTINUITY_CORRECTED
    : CONTINUITY_LEDGER;
}

// ── WHICH CONVENTION A STORED ROW WAS PRICED WITH ───────────────────────────
// ledgerContinuity() answers "what does pOver write TODAY". Anything re-scoring
// HISTORY needs the term each stored row was actually written with, which is a
// property of when it was written — and that is NOT recoverable from
// model_version: the 2026-08-03 cutover bumped both tiers (v3→v4, v2→v3), so
// 'wnba-v3' means the OLD convention on a pre-cutover row and the NEW one on a
// post-cutover fallback row.
//
// Keyed on game_date, not created_at: daily-predict.mjs upserts on
// (game_date, player_norm, stat) and only ever writes TODAY's slate, so every
// row for a given game_date carries the price of whatever convention was live
// that day — including the 2026-08-03 rows, first written pre-dawn under v3 and
// overwritten by the 11:07 ET pass after the cutover landed at 08:13 ET.
//
// APPEND to this table, never edit a row — each entry is a historical fact about
// what is sitting in wnba_picks. Add an entry in the SAME commit that flips
// pOver's default and bumps MODEL_VERSION; lib/pricing.test.mjs pins the last
// entry to the live default so a half-done cutover cannot ship.
export const CONTINUITY_HISTORY = [
  ['0000-00-00', CONTINUITY_LEDGER],     // launch through 2026-08-02 games
  ['2026-08-03', CONTINUITY_CORRECTED],  // wnba-v4 cutover (shadow slate shipped 2026-08-03)
];

export function writtenContinuity(gameDate) {
  const d = gameDate || '';
  let term = CONTINUITY_HISTORY[0][1];
  for (const [from, t] of CONTINUITY_HISTORY) if (d >= from) term = t;
  return term;
}

// ── advanced layer (mirrors the App.jsx ctx: stats.wnba.com + gravity) ───────
// Node has no CORS, but stats.nba.com Akamai-blocks many datacenter IPs — so every
// fetch tries direct first, then falls over to the Supabase edge proxies.
const PROXIES = process.env.SUPABASE_URL ? [
  { base: `${process.env.SUPABASE_URL}/functions/v1/nba-proxy`, key: process.env.SUPABASE_PUBLISHABLE_KEY },
] : [];
const STATS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.wnba.com/', 'Origin': 'https://www.wnba.com',
  'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
async function fetchWithTimeout(url, opts = {}, ms = 15_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}
async function statsJSON(endpoint, params) {
  const qs = new URLSearchParams(params).toString();
  try { // direct
    const url = endpoint === 'gravity'
      ? `https://www.wnba.com/api/gravity/leaders?${qs}`
      : `https://stats.nba.com/stats/${endpoint}?${qs}`;
    const r = await fetchWithTimeout(url, { headers: STATS_HEADERS });
    if (r.ok) return await r.json();
  } catch {}
  for (const { base, key } of PROXIES) { // proxies
    try {
      const r = await fetchWithTimeout(`${base}?endpoint=${endpoint}&${qs}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }, 30_000);
      if (!r.ok) continue;
      const j = await r.json();
      if (!j?.error) return j;
    } catch {}
  }
  return null;
}

const TEAM_KEYWORDS = [
  ['atlanta','ATL'],['chicago','CHI'],['connecticut','CON'],['dallas','DAL'],
  ['golden state','GS'],['valkyr','GS'],['indiana','IND'],['las vegas','LV'],['aces','LV'],
  ['sparks','LA'],['los angeles','LA'],['minnesota','MIN'],['new york','NY'],['liberty','NY'],
  ['phoenix','PHX'],['portland','POR'],['seattle','SEA'],['toronto','TOR'],['washington','WSH'],
];
const abbrFromName = n => { const s = (n||'').toLowerCase(); for (const [kw,a] of TEAM_KEYWORDS) if (s.includes(kw)) return a; return null; };
const LEAGUEDASH_DEFAULTS = {
  PlusMinus:'N', Rank:'N', PaceAdjust:'N', Period:'0', LastNGames:'0', Month:'0',
  TeamID:'0', OpponentTeamID:'0', DateFrom:'', DateTo:'', GameSegment:'',
  SeasonSegment:'', VsConference:'', VsDivision:'', Location:'', Outcome:'',
  PlayerExperience:'', PlayerPosition:'', StarterBench:'', PORound:'',
  ShotClockRange:'', TwoWay:'0', GameScope:'',
};
const rsOf = j => j?.resultSets?.[0] ?? j?.resultSet?.[0] ?? null;

// ── live roster ─────────────────────────────────────────────────────────────
// PROJ (extracted from App.jsx) is a hand-curated preseason seed frozen at the
// initial commit — it misses trades, rookies who won a rotation spot, and the two
// 2026 expansion teams' signings. Those players never get a pick written to
// wnba_picks, so they never reach the feed / lab / promotion gate. The roster is
// derived from ESPN box-score logs (rosterFromLogs, below collectLogs) and merged
// in here. MIRRORS rosterFromLogs / mergeLiveRoster in src/App.jsx (same GP>=3,
// MIN>=10 thresholds) — keep them in sync so the nightly pick loop and the dashboard
// project the same player pool.

// Append any live-roster player at real rotation minutes the seed lacks. Auto-added
// rows carry their season-to-date per-game line as the model prior — safe for
// forward prediction (no lookahead) since dataWeight (REGRESSION_N) already leans on
// real recent games by the time a player has this many GP.
export function mergeRoster(proj, live) {
  const known = new Set(proj.map(p => normalizeName(p.n)));
  const extras = (live || [])
    .filter(p => p.t && p.gp >= 3 && p.min >= 10 && !known.has(normalizeName(p.n)))
    .map(p => ({
      n:p.n, t:p.t, pos:'',
      min:p.min, fg3m:p.fg3m, reb:p.reb, ast:p.ast, stl:p.stl, blk:p.blk, pts:p.pts,
      auto:true,
    }));
  return extras.length ? [...proj, ...extras] : proj;
}

// Derive team-defense + environment proxies straight from the ESPN box-score logs
// we already collect. stats.nba.com fingerprints TLS and blocks every non-browser
// client (curl, Node, cloud proxies alike), so the nightly job can't count on the
// official Opponent/Advanced tables — but points/rebounds/assists ALLOWED per game
// are fully reconstructible from our own log store, leakage-free.
export function deriveTeamCtxFromLogs(logs) {
  const allowed = {};   // abbr → { date → totals scored AGAINST that team }
  for (const arr of Object.values(logs)) {
    for (const g of arr) {
      const opp = (g.opp || '').toUpperCase();
      if (!opp) continue;
      const day = ((allowed[opp] ||= {})[g.date] ||= { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fg3m: 0 });
      day.pts += g.pts; day.reb += g.reb; day.ast += g.ast;
      day.stl += g.stl; day.blk += g.blk; day.fg3m += g.fg3m;
    }
  }
  const teamOpponent = {}, teamAdvanced = {};
  const meanBy = (days, k) => { const v = Object.values(days).map(d => d[k]); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  for (const [abbr, days] of Object.entries(allowed)) {
    teamOpponent[abbr] = {
      oppPts: meanBy(days, 'pts'), oppReb: meanBy(days, 'reb'), oppAst: meanBy(days, 'ast'),
      oppFg3m: meanBy(days, 'fg3m'), oppStl: meanBy(days, 'stl'), oppBlk: meanBy(days, 'blk'),
      oppFgPct: null, oppFg3Pct: null, gp: Object.keys(days).length,
    };
  }
  const leaguePtsAllowed = Object.values(teamOpponent).map(t => t.oppPts).filter(v => v != null);
  const lpa = leaguePtsAllowed.length ? leaguePtsAllowed.reduce((a, b) => a + b, 0) / leaguePtsAllowed.length : null;
  for (const [abbr, t] of Object.entries(teamOpponent)) {
    // defRating proxy: points allowed vs league; pace/offRating left null (their
    // factors simply don't fire — better than firing on a bad proxy).
    teamAdvanced[abbr] = { pace: null, offRating: null, defRating: lpa ? 100 * (t.oppPts / lpa) : null };
  }
  return { teamOpponent, teamAdvanced };
}

// Pull the entire advanced ctx. Any piece that fails comes back empty; returns
// { ctx, complete, source } where complete=true when a team-defense layer exists —
// from stats.nba.com when reachable, else derived from our own box-score logs.
export async function fetchAdvancedContext(season = String(new Date().getUTCFullYear()), logs = null) {
  const common = { LeagueID: '10', Season: season, SeasonType: 'Regular Season', PerMode: 'PerGame', ...LEAGUEDASH_DEFAULTS };
  const [tAdvJ, tOppJ, pScoreJ, pAdvJ, gravJ] = await Promise.all([
    statsJSON('leaguedashteamstats',   { ...common, MeasureType: 'Advanced' }),
    statsJSON('leaguedashteamstats',   { ...common, MeasureType: 'Opponent' }),
    statsJSON('leaguedashplayerstats', { ...common, MeasureType: 'Scoring' }),
    statsJSON('leaguedashplayerstats', { ...common, MeasureType: 'Advanced' }),
    statsJSON('gravity', { season, seasonType: 'Regular Season' }),
  ]);

  const teamAdvanced = {}, teamOpponent = {}, playerScoring = {}, advanced = {}, gravity = {};
  { const rs = rsOf(tAdvJ); if (rs) { const ix = k => rs.headers.indexOf(k);
    for (const row of rs.rowSet) { const a = abbrFromName(row[ix('TEAM_NAME')]); if (!a) continue;
      teamAdvanced[a] = { pace: row[ix('PACE')], offRating: row[ix('OFF_RATING')], defRating: row[ix('DEF_RATING')] }; } } }
  { const rs = rsOf(tOppJ); if (rs) { const ix = k => rs.headers.indexOf(k);
    for (const row of rs.rowSet) { const a = abbrFromName(row[ix('TEAM_NAME')]); if (!a) continue;
      teamOpponent[a] = { oppPts: row[ix('OPP_PTS')], oppReb: row[ix('OPP_REB')], oppAst: row[ix('OPP_AST')],
        oppFg3m: row[ix('OPP_FG3M')], oppStl: row[ix('OPP_STL')], oppBlk: row[ix('OPP_BLK')],
        oppFgPct: row[ix('OPP_FG_PCT')], oppFg3Pct: row[ix('OPP_FG3_PCT')] }; } } }
  { const rs = rsOf(pScoreJ); if (rs) { const ix = k => rs.headers.indexOf(k);
    for (const row of rs.rowSet) playerScoring[normalizeName(row[ix('PLAYER_NAME')])] = {
      pctPts3: row[ix('PCT_PTS_3PT')], pctPtsPaint: row[ix('PCT_PTS_PAINT')],
      pctPtsFt: row[ix('PCT_PTS_FT')], pctUast: row[ix('PCT_UAST_FGM')] }; } }
  { const rs = rsOf(pAdvJ); if (rs) { const ix = k => rs.headers.indexOf(k);
    for (const row of rs.rowSet) advanced[normalizeName(row[ix('PLAYER_NAME')])] = {
      usgPct: row[ix('USG_PCT')], tsPct: row[ix('TS_PCT')], astPct: row[ix('AST_PCT')],
      orebPct: row[ix('OREB_PCT')], drebPct: row[ix('DREB_PCT')] }; } }
  for (const p of (gravJ?.leaders || [])) {
    const norm = normalizeName(`${p.FIRSTNAME ?? ''} ${p.LASTNAME ?? ''}`); if (!norm) continue;
    gravity[norm] = { gravity: p.GRAVITYSCORE ?? null, team: abbrFromName(`${p.TEAMCITY ?? ''} ${p.TEAMNAME ?? ''}`) };
  }
  const teamGravity = {};
  for (const g of Object.values(gravity)) { if (!g.team || g.gravity == null) continue;
    (teamGravity[g.team] ||= { sum: 0, n: 0 }); teamGravity[g.team].sum += g.gravity; teamGravity[g.team].n++; }

  // Official team tables unreachable (TLS-fingerprint bot-wall) → derive the
  // defense layer from our own collected box scores instead.
  let source = 'stats.nba.com';
  if (Object.keys(teamOpponent).length < 8 && logs) {
    const derived = deriveTeamCtxFromLogs(logs);
    if (Object.keys(derived.teamOpponent).length >= 8) {
      Object.assign(teamOpponent, derived.teamOpponent);
      Object.assign(teamAdvanced, derived.teamAdvanced);
      source = 'derived-from-box-scores';
    }
  }

  const mean = a => { const v = a.filter(x => x != null && !Number.isNaN(x)); return v.length ? v.reduce((x,y)=>x+y,0)/v.length : null; };
  const opps = Object.values(teamOpponent), advs = Object.values(teamAdvanced);
  const leagueAvg = {
    oppPts: mean(opps.map(t=>t.oppPts)) ?? 83.2, oppReb: mean(opps.map(t=>t.oppReb)) ?? 35.1,
    oppAst: mean(opps.map(t=>t.oppAst)) ?? 19.8, oppFg3m: mean(opps.map(t=>t.oppFg3m)) ?? 8.2,
    oppStl: mean(opps.map(t=>t.oppStl)) ?? 6.8, oppBlk: mean(opps.map(t=>t.oppBlk)) ?? 4.5,
    oppFgPct: mean(opps.map(t=>t.oppFgPct)) ?? 0.435, oppFg3Pct: mean(opps.map(t=>t.oppFg3Pct)) ?? 0.335,
    pace: mean(advs.map(t=>t.pace)) ?? 97.5, offRating: mean(advs.map(t=>t.offRating)) ?? 100,
    defRating: mean(advs.map(t=>t.defRating)) ?? 100,
  };
  const complete = Object.keys(teamOpponent).length >= 8;
  return { ctx: { teamAdvanced, teamOpponent, playerScoring, advanced, gravity, teamGravity, leagueAvg }, complete, source };
}

// σ shaping from HOW a player produces (mirrors App.jsx::computeSigmaProfileMult).
// ── Projection (public reference implementation) ──────────────────────────
// Mirrors buildWNBAModel in src/App.jsx: the production model is private, and
// this stand-in keeps the cron's inputs and the wnba_picks row shape.
//   base  = preseason projection blended with recency-weighted logs
//   adj   = base × opponent points-allowed ratio (pts / pra only, ±6%)
//   sigma = sample SD shrunk toward a mean-proportional prior
export function predictStat(priorLogs, projPlayer, statCfg, upcoming, ctx = null) {
  const projLine = statCfg.prior(projPlayer) * (PRIOR_CAL[statCfg.id] ?? 1);
  const pv = priorLogs.map(statCfg.val);
  const gp = pv.length;
  if (gp < MIN_GAMES) return null;

  const rm = recencyMean(pv);
  const dw = gp / (gp + REGRESSION_N);
  const base = projLine * (1 - dw) + rm * dw;

  let adj = base;
  const allowed = upcoming?.opp ? ctx?.teamOpponent?.[upcoming.opp]?.oppPts : null;
  const leaguePts = ctx?.leagueAvg?.oppPts;
  if (allowed != null && leaguePts && (statCfg.id === 'pts' || statCfg.id === 'pra')) {
    adj *= clampMult(allowed / leaguePts, 0.94, 1.06);
  }

  let aS = sd(pv); if (aS != null) aS *= Math.sqrt((gp + 1) / gp);
  const eS = Math.max(SIGMA_FLOOR[statCfg.id] ?? 1.5, adj * (SIGMA_COEFF[statCfg.id] ?? 0.40));
  const wA = gp / (gp + SIG_K);
  const sig = aS != null ? aS * wA + eS * (1 - wA) : eS;

  let line = LINES[statCfg.id][0], best = 1e9;
  for (const L of LINES[statCfg.id]) { const dd = Math.abs(L - adj); if (dd < best) { best = dd; line = L; } }

  const probOver = pOver(adj, line, statCfg.id, sig);
  if (probOver == null) return null;
  return {
    projection: +adj.toFixed(2),
    sigma: +sig.toFixed(2),
    line,
    probOver: +probOver.toFixed(4),
    side: probOver >= 0.5 ? 'over' : 'under',
    gp,
    gravity: null,
    mateGravity: null,
    sigmaProfile: 1,
  };
}

// ── ESPN data pull (mirrors recalibrate.mjs::collectLogs) ───────────────────
const SB  = 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard';
const SUM = 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/summary';
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const made = s => s && s.includes('-') ? parseInt(s.split('-')[0], 10) || 0 : parseInt(s, 10) || 0;
async function getJSON(u){for(let i=0;i<4;i++){try{const r=await fetch(u);if(r.ok)return await r.json();}catch{}await new Promise(r=>setTimeout(r,500));}return null;}

// Pull finished-game box scores between two Dates → { logs, games }.
// logs[normName] = [{ date:'YYYYMMDD', opp, home, pts, reb, ast, stl, blk, fg3m }]
export async function collectLogs(start, end) {
  const dates = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) dates.push(ymd(new Date(d)));
  const events = [];
  for (const dt of dates) {
    const j = await getJSON(SB + '?dates=' + dt);
    for (const e of (j?.events || [])) {
      if (e.status?.type?.state !== 'post') continue;
      const c = e.competitions?.[0];
      events.push({
        id: e.id, date: dt,
        home: c?.competitors?.find(x => x.homeAway === 'home')?.team?.abbreviation,
        away: c?.competitors?.find(x => x.homeAway === 'away')?.team?.abbreviation,
      });
    }
  }
  const logs = {}, names = {};
  for (const ev of events) {
    const j = await getJSON(SUM + '?event=' + ev.id);
    for (const tb of (j?.boxscore?.players || [])) {
      const abbr = tb.team?.abbreviation, opp = abbr === ev.home ? ev.away : ev.home, home = abbr === ev.home;
      const st = tb.statistics?.[0]; if (!st) continue;
      const idx = k => st.labels.indexOf(k);
      for (const a of (st.athletes || [])) {
        if (a.didNotPlay || !a.stats?.length) continue;
        const s = a.stats;
        const norm = normalizeName(a.athlete?.displayName);
        if (!names[norm]) names[norm] = a.athlete?.displayName || norm;
        const g = { date: ev.date, team: abbr, opp, home, min:+s[idx('MIN')]||0, pts:+s[idx('PTS')]||0, reb:+s[idx('REB')]||0, ast:+s[idx('AST')]||0, stl:+s[idx('STL')]||0, blk:+s[idx('BLK')]||0, fg3m: made(s[idx('3PT')]) };
        (logs[norm] ||= []).push(g);
      }
    }
  }
  for (const k in logs) logs[k].sort((a, b) => a.date.localeCompare(b.date));
  return { logs, games: events.length, roster: rosterFromLogs(logs, names) };
}

// Derive a live roster (name, team, per-game averages) from the ESPN box-score logs
// collectLogs already builds — the production/CI-reachable source. We used to pull the
// full league roster from stats.nba.com (leaguedashplayerstats), but that endpoint is
// Akamai-blocked from datacenter egress (Vercel serverless times out; GitHub Actions
// is the same shape), so building from ESPN is what actually reaches the added players.
// Order-independent on sort: current team is the newest game's team.
// → [{ n, t, gp, min, fg3m, reb, ast, stl, blk, pts }]
export function rosterFromLogs(logs, names) {
  const out = [];
  for (const [norm, gl] of Object.entries(logs || {})) {
    if (!gl || gl.length < 3) continue;
    const newest = gl.reduce((a, b) => (a.date >= b.date ? a : b));
    const avg = k => gl.reduce((s, g) => s + (g[k] ?? 0), 0) / gl.length;
    out.push({
      n: names?.[norm] || norm,
      t: newest.team || null,
      gp: gl.length,
      min: avg('min'), pts: avg('pts'), reb: avg('reb'), ast: avg('ast'),
      fg3m: avg('fg3m'), stl: avg('stl'), blk: avg('blk'),
    });
  }
  return out;
}

// Today's (or any date's) scheduled games → [{ id, home, away, state }] abbrevs.
export async function fetchSchedule(dateStr /* 'YYYYMMDD' */) {
  const j = await getJSON(SB + '?dates=' + dateStr + '&limit=20');
  return (j?.events || []).map(e => {
    const c = e.competitions?.[0];
    return {
      id: e.id,
      state: e.status?.type?.state || 'pre',
      home: c?.competitors?.find(x => x.homeAway === 'home')?.team?.abbreviation,
      away: c?.competitors?.find(x => x.homeAway === 'away')?.team?.abbreviation,
    };
  });
}
