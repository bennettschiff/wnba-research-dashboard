import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import SportSwitcher from "./components/SportSwitcher.jsx";

// ── API BASES ────────────────────────────────────────────────────────────────
const ESPN_BASE = "/espn-site/apis/site/v2/sports/basketball/wnba";
const ESPN_CORE = "/espn-core/v2/sports/basketball/leagues/wnba";

// ── NBA STATS PROXY (Supabase edge function — bypasses CORS/bot-walls) ──────
const PROXIES = [
  { base: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/nba-proxy`,
    key: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
];

// Picks DB: daily-predict.mjs writes and grades wnba_picks nightly; the Results
// tab reads it with the publishable key (RLS keeps it read-only).
const PICKS_REST = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1`;
const PICKS_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// ── IN-MEMORY CACHE ──────────────────────────────────────────────────────────
const _cache = new Map();
async function cacheFetch(url, ttl = 900_000) {
  const hit = _cache.get(url);
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const data = await res.json();
  _cache.set(url, { data, ts: Date.now() });
  return data;
}

async function nbaProxyFetch(endpoint, params = {}) {
  const qs = new URLSearchParams({ endpoint, ...params }).toString();
  const cacheKey = `proxy:${qs}`;
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < 900_000) return hit.data;
  // stats.nba.com's Akamai wall blocks direct browser fetches from foreign origins
  // (hangs, no error) and Deno edge IPs, but passes Node's fetch — so the order is:
  //   1. same-origin Vercel fn (/api/nba-stats, prod — Node relay)
  //   2. vite dev proxy (/wnba-stats, dev server relay)
  //   3. Supabase edge proxies (gravity always works here; leaguedash usually walled)
  const attempts = [{ url: `/api/nba-stats?${qs}`, headers: {} }];
  if (endpoint !== 'gravity') {
    attempts.push({ url: `/wnba-stats/stats/${endpoint}?${new URLSearchParams(params)}`, headers: {} });
  }
  for (const { base, key } of PROXIES) {
    attempts.push({ url: `${base}?${qs}`, headers: { apikey: key, Authorization: `Bearer ${key}` } });
  }
  let lastErr;
  for (const { url, headers } of attempts) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 12_000);
      const res = await fetch(url, { headers, signal: ac.signal }).finally(() => clearTimeout(t));
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const data = await res.json(); // SPA-fallback HTML (404 routes) throws here → next attempt
      if (data?.error) throw new Error(String(data.error)); // upstream failed inside the relay
      _cache.set(cacheKey, { data, ts: Date.now() });
      return data;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('all stats sources failed');
}

async function fetchWNBALeagueGameLog(season = '2026') {
  const json = await nbaProxyFetch('leaguegamelog', {
    LeagueID: '10', Season: season, SeasonType: 'Regular Season',
    PlayerOrTeam: 'P', Counter: '0', Direction: 'DESC', Sorter: 'DATE',
    DateFrom: '', DateTo: '',
  });
  const rs = json.resultSets?.[0] ?? json.resultSet?.[0];
  if (!rs) return {};
  const H = rs.headers;
  const ix = k => H.indexOf(k);
  const nameI = ix('PLAYER_NAME'), dateI = ix('GAME_DATE'), matchupI = ix('MATCHUP');
  const minI = ix('MIN'), ptsI = ix('PTS'), rebI = ix('REB'), astI = ix('AST');
  const stlI = ix('STL'), blkI = ix('BLK'), tovI = ix('TOV'), pmI = ix('PLUS_MINUS');
  const fg3mI = ix('FG3M'), fg3aI = ix('FG3A'), fgmI = ix('FGM'), fgaI = ix('FGA');
  const ftmI = ix('FTM'), ftaI = ix('FTA'), orebI = ix('OREB'), drebI = ix('DREB');
  const map = {};
  for (const row of rs.rowSet) {
    const norm = normalizeName(row[nameI]);
    const matchup = row[matchupI] || '';
    const home = matchup.includes('vs.');
    const parts = matchup.split(/\s+vs\.\s+|\s+@\s+/);
    const opp = (parts[1] || '').trim();
    if (!map[norm]) map[norm] = [];
    map[norm].push({
      date: row[dateI], opp, home,
      pts: row[ptsI] ?? 0, reb: row[rebI] ?? 0, ast: row[astI] ?? 0,
      stl: row[stlI] ?? 0, blk: row[blkI] ?? 0, to: row[tovI] ?? 0,
      oreb: row[orebI] ?? 0, dreb: row[drebI] ?? 0, pm: row[pmI] ?? 0,
      fg3m: row[fg3mI] ?? 0, fg3a: row[fg3aI] ?? 0,
      fgm: row[fgmI] ?? 0, fga: row[fgaI] ?? 0,
      ftm: row[ftmI] ?? 0, fta: row[ftaI] ?? 0,
      min: row[minI] != null ? parseFloat(row[minI]) : null,
    });
  }
  return map;
}

async function fetchWNBAAdvancedStats(season = '2026') {
  const json = await nbaProxyFetch('leaguedashplayerstats', {
    LeagueID: '10', Season: season, SeasonType: 'Regular Season',
    MeasureType: 'Advanced', PerMode: 'PerGame',
    PlusMinus: 'N', Rank: 'N', PaceAdjust: 'N',
    Period: '0', LastNGames: '0', Month: '0',
    TeamID: '0', OpponentTeamID: '0',
    DateFrom: '', DateTo: '', GameSegment: '', SeasonSegment: '',
    VsConference: '', VsDivision: '', Location: '', Outcome: '',
    PlayerExperience: '', PlayerPosition: '', StarterBench: '',
    PORound: '', ShotClockRange: '', TwoWay: '0', GameScope: '',
  });
  const rs = json.resultSets?.[0] ?? json.resultSet?.[0];
  if (!rs) return {};
  const H = rs.headers;
  const ix = k => H.indexOf(k);
  const nameI = ix('PLAYER_NAME');
  const usgI = ix('USG_PCT'), tsI = ix('TS_PCT'), efgI = ix('EFG_PCT');
  const astpI = ix('AST_PCT'), orebpI = ix('OREB_PCT'), drebpI = ix('DREB_PCT');
  const map = {};
  for (const row of rs.rowSet) {
    const norm = normalizeName(row[nameI]);
    map[norm] = {
      usgPct: row[usgI], tsPct: row[tsI], efgPct: row[efgI],
      astPct: row[astpI], orebPct: row[orebpI], drebPct: row[drebpI],
    };
  }
  return map;
}

// stats.wnba.com returns TEAM_NAME (no abbrev). Map full name → PROJ_2026 abbrev by keyword.
const WNBA_TEAM_NAME_KEYWORDS = [
  ['atlanta', 'ATL'], ['chicago', 'CHI'], ['connecticut', 'CON'], ['dallas', 'DAL'],
  ['golden state', 'GS'], ['valkyr', 'GS'], ['indiana', 'IND'], ['las vegas', 'LV'],
  ['aces', 'LV'], ['sparks', 'LA'], ['los angeles', 'LA'], ['minnesota', 'MIN'],
  ['new york', 'NY'], ['liberty', 'NY'], ['phoenix', 'PHX'], ['portland', 'POR'],
  ['seattle', 'SEA'], ['toronto', 'TOR'], ['washington', 'WSH'],
];
function wnbaAbbrFromName(name) {
  const n = (name || '').toLowerCase();
  for (const [kw, abbr] of WNBA_TEAM_NAME_KEYWORDS) if (n.includes(kw)) return abbr;
  return null;
}

// Shared param block for the leaguedash* family (stats.wnba.com wants every filter present).
const LEAGUEDASH_DEFAULTS = {
  PlusMinus: 'N', Rank: 'N', PaceAdjust: 'N', Period: '0', LastNGames: '0', Month: '0',
  TeamID: '0', OpponentTeamID: '0', DateFrom: '', DateTo: '', GameSegment: '',
  SeasonSegment: '', VsConference: '', VsDivision: '', Location: '', Outcome: '',
  PlayerExperience: '', PlayerPosition: '', StarterBench: '', PORound: '',
  ShotClockRange: '', TwoWay: '0', GameScope: '',
};

// Team advanced stats — real pace + off/def rating. → { [abbr]: { pace, offRating, defRating, gp } }
async function fetchWNBATeamAdvanced(season = String(ACTIVE_SEASON)) {
  const json = await nbaProxyFetch('leaguedashteamstats', {
    LeagueID: '10', Season: season, SeasonType: 'Regular Season',
    MeasureType: 'Advanced', PerMode: 'PerGame', ...LEAGUEDASH_DEFAULTS,
  });
  const rs = json.resultSets?.[0] ?? json.resultSet?.[0];
  if (!rs) return {};
  const H = rs.headers; const ix = k => H.indexOf(k);
  const nameI = ix('TEAM_NAME'), paceI = ix('PACE'), offI = ix('OFF_RATING'), defI = ix('DEF_RATING'), gpI = ix('GP');
  const map = {};
  for (const row of rs.rowSet) {
    const abbr = wnbaAbbrFromName(row[nameI]);
    if (!abbr) continue;
    map[abbr] = {
      pace:      paceI >= 0 ? row[paceI] : null,
      offRating: offI  >= 0 ? row[offI]  : null,
      defRating: defI  >= 0 ? row[defI]  : null,
      gp:        gpI   >= 0 ? row[gpI]   : null,
    };
  }
  return map;
}

// Team opponent stats — what each team ALLOWS per game (true defense).
// → { [abbr]: { oppPts, oppReb, oppAst, oppFg3m, oppStl, oppBlk, oppFgPct, oppFg3Pct, gp } }
async function fetchWNBATeamOpponent(season = String(ACTIVE_SEASON)) {
  const json = await nbaProxyFetch('leaguedashteamstats', {
    LeagueID: '10', Season: season, SeasonType: 'Regular Season',
    MeasureType: 'Opponent', PerMode: 'PerGame', ...LEAGUEDASH_DEFAULTS,
  });
  const rs = json.resultSets?.[0] ?? json.resultSet?.[0];
  if (!rs) return {};
  const H = rs.headers; const ix = k => H.indexOf(k);
  const nameI = ix('TEAM_NAME');
  const ptsI = ix('OPP_PTS'), rebI = ix('OPP_REB'), astI = ix('OPP_AST'), fg3mI = ix('OPP_FG3M');
  const stlI = ix('OPP_STL'), blkI = ix('OPP_BLK'), fgpI = ix('OPP_FG_PCT'), fg3pI = ix('OPP_FG3_PCT'), gpI = ix('GP');
  const map = {};
  for (const row of rs.rowSet) {
    const abbr = wnbaAbbrFromName(row[nameI]);
    if (!abbr) continue;
    map[abbr] = {
      oppPts:   ptsI  >= 0 ? row[ptsI]  : null,
      oppReb:   rebI  >= 0 ? row[rebI]  : null,
      oppAst:   astI  >= 0 ? row[astI]  : null,
      oppFg3m:  fg3mI >= 0 ? row[fg3mI] : null,
      oppStl:   stlI  >= 0 ? row[stlI]  : null,
      oppBlk:   blkI  >= 0 ? row[blkI]  : null,
      oppFgPct: fgpI  >= 0 ? row[fgpI]  : null,
      oppFg3Pct:fg3pI >= 0 ? row[fg3pI] : null,
      gp:       gpI   >= 0 ? row[gpI]   : null,
    };
  }
  return map;
}

// Player scoring profile — shot mix + assisted share, for σ / role signal.
// → { [normName]: { pctPts3, pctPtsPaint, pctPtsFt, pctUast } }  (values 0..1)
async function fetchWNBAPlayerScoring(season = String(ACTIVE_SEASON)) {
  const json = await nbaProxyFetch('leaguedashplayerstats', {
    LeagueID: '10', Season: season, SeasonType: 'Regular Season',
    MeasureType: 'Scoring', PerMode: 'PerGame', ...LEAGUEDASH_DEFAULTS,
  });
  const rs = json.resultSets?.[0] ?? json.resultSet?.[0];
  if (!rs) return {};
  const H = rs.headers; const ix = k => H.indexOf(k);
  const nameI = ix('PLAYER_NAME');
  const p3I = ix('PCT_PTS_3PT'), paintI = ix('PCT_PTS_PAINT'), ftI = ix('PCT_PTS_FT'), uastI = ix('PCT_UAST_FGM');
  const map = {};
  for (const row of rs.rowSet) {
    const norm = normalizeName(row[nameI]);
    map[norm] = {
      pctPts3:     p3I    >= 0 ? row[p3I]    : null,
      pctPtsPaint: paintI >= 0 ? row[paintI] : null,
      pctPtsFt:    ftI    >= 0 ? row[ftI]    : null,
      pctUast:     uastI  >= 0 ? row[uastI]  : null,
    };
  }
  return map;
}

// Derive a live roster (name, team, per-game averages) from the ESPN box-score game
// logs the app already collects. PROJ_2026 is a hand-curated preseason seed (~100
// names) frozen at initial commit — it misses trades, rookies who won a rotation spot,
// and signings to the two 2026 expansion teams. We used to pull the full league roster
// from stats.wnba.com, but stats.nba.com is Akamai-blocked from Vercel's serverless
// egress (the /api/nba-stats relay times out in prod), so the roster is built from ESPN
// box scores instead — the same source that already works in production for game logs.
// `logs` is { norm: [game,…] } with each game carrying { team, min, pts, … }; `names`
// is { norm: displayName }.
// → [{ n, t, gp, min, fg3m, reb, ast, stl, blk, pts }]
function rosterFromLogs(logs, names) {
  const out = [];
  for (const [norm, gl] of Object.entries(logs || {})) {
    if (!gl || gl.length < 3) continue;
    const avg = k => gl.reduce((s, g) => s + (g[k] ?? 0), 0) / gl.length;
    out.push({
      n:   names?.[norm] || norm,
      t:   gl[0]?.team || null,   // newest game's team (handles mid-season trades)
      gp:  gl.length,
      min: avg('min'), pts: avg('pts'), reb: avg('reb'), ast: avg('ast'),
      fg3m: avg('fg3m'), stl: avg('stl'), blk: avg('blk'),
    });
  }
  return out;
}

// Merge PROJ_2026 with any live-roster player at real rotation minutes (GP>=3, MIN>=10)
// it doesn't already have. Auto-added rows use their season-to-date per-game line as the
// model prior — reasonable since dataWeight (REGRESSION_N below) already leans on real
// recent games over the prior by the time a player has that many GP.
function mergeLiveRoster(liveRoster) {
  const known = new Set(PROJ_2026.map(p => normalizeName(p.n)));
  const extras = (liveRoster || [])
    .filter(p => p.t && p.gp >= 3 && p.min >= 10 && !known.has(normalizeName(p.n)))
    .map(p => ({
      n: p.n, t: p.t, pos: "",
      min: p.min, fg3m: p.fg3m, reb: p.reb, ast: p.ast, stl: p.stl, blk: p.blk, pts: p.pts,
      auto: true,
    }));
  return extras.length ? [...PROJ_2026, ...extras] : PROJ_2026;
}

// Gravity — WNBA Inside the Game (AWS player-tracking ML). Measures how much
// defensive attention a player draws vs what floor spacing predicts, -100..100
// with 0 = league average, split on/off-ball × perimeter/interior.
// Public JSON at www.wnba.com/api/gravity/leaders (CORS-locked → via proxy).
// → { [normName]: { gravity, onBallPerim, offBallPerim, onBallInt, offBallInt, gp, team } }
async function fetchWNBAGravity(season = String(ACTIVE_SEASON)) {
  const json = await nbaProxyFetch('gravity', { season, seasonType: 'Regular Season' });
  const map = {};
  for (const p of (json?.leaders || [])) {
    const norm = normalizeName(`${p.FIRSTNAME ?? ''} ${p.LASTNAME ?? ''}`);
    if (!norm) continue;
    map[norm] = {
      gravity:      p.GRAVITYSCORE ?? null,
      onBallPerim:  p.ONBALLPERIMETERGRAVITYSCORE ?? null,
      offBallPerim: p.OFFBALLPERIMETERGRAVITYSCORE ?? null,
      onBallInt:    p.ONBALLINTERIORGRAVITYSCORE ?? null,
      offBallInt:   p.OFFBALLINTERIORGRAVITYSCORE ?? null,
      gp:           p.GAMESPLAYED ?? null,
      // gravity feed uses its own abbrevs (WAS/LVA/PDX) — map via city+name keywords
      team:         wnbaAbbrFromName(`${p.TEAMCITY ?? ''} ${p.TEAMNAME ?? ''}`),
    };
  }
  return map;
}

// Team spacing environment from gravity: per team, the sum/count of tracked
// players' overall gravity. The model derives "teammate gravity" (excluding the
// player themself) — playing next to high-gravity teammates = easier looks.
function computeTeamGravity(gravityMap) {
  const t = {};
  for (const g of Object.values(gravityMap)) {
    if (!g.team || g.gravity == null) continue;
    (t[g.team] ||= { sum: 0, n: 0 });
    t[g.team].sum += g.gravity;
    t[g.team].n++;
  }
  return t;
}

// Derive opponent-allowed stats straight from the box-score log cache. In prod the
// stats.nba.com Opponent table is often unreachable (Akamai walls every datacenter
// path; only the vite dev proxy gets through) — but points/rebounds/assists ALLOWED
// are reconstructible from the ESPN logs we already hold. Undercounts slightly
// (only projected players' lines are cached), but the defense composite works off
// ratios to a league average computed from this same map, so the bias cancels.
function deriveTeamStatsFromLogs(logCache) {
  const allowed = {};
  for (const entry of Object.values(logCache)) {
    for (const g of (entry?.logs || [])) {
      const opp = (g.opp || '').toUpperCase();
      const day = g.date;
      if (!opp || !day) continue;
      const d = ((allowed[opp] ||= {})[day] ||= { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fg3m: 0 });
      d.pts += g.pts ?? 0; d.reb += g.reb ?? 0; d.ast += g.ast ?? 0;
      d.stl += g.stl ?? 0; d.blk += g.blk ?? 0; d.fg3m += g.fg3m ?? 0;
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
  const pa = Object.values(teamOpponent).map(t => t.oppPts).filter(v => v != null);
  const lpa = pa.length ? pa.reduce((a, b) => a + b, 0) / pa.length : null;
  for (const [abbr, t] of Object.entries(teamOpponent)) {
    teamAdvanced[abbr] = { pace: null, offRating: null, defRating: lpa ? 100 * (t.oppPts / lpa) : null };
  }
  return { teamOpponent, teamAdvanced };
}

// League-average anchors for opponent/pace factors — computed from live data with
// hardcoded fallback so the multipliers are self-calibrating as the season fills in.
function meanOf(arr) {
  const v = arr.filter(x => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function computeModelLeagueAvg(teamOpponent = {}, teamAdvanced = {}) {
  const opps = Object.values(teamOpponent);
  const advs = Object.values(teamAdvanced);
  return {
    oppPts:    meanOf(opps.map(t => t.oppPts))    ?? WNBA_LEAGUE_AVG.pts,
    oppReb:    meanOf(opps.map(t => t.oppReb))    ?? WNBA_LEAGUE_AVG.reb,
    oppAst:    meanOf(opps.map(t => t.oppAst))    ?? WNBA_LEAGUE_AVG.ast,
    oppFg3m:   meanOf(opps.map(t => t.oppFg3m))   ?? WNBA_LEAGUE_AVG.fg3m,
    oppStl:    meanOf(opps.map(t => t.oppStl))    ?? WNBA_LEAGUE_AVG.stl,
    oppBlk:    meanOf(opps.map(t => t.oppBlk))    ?? WNBA_LEAGUE_AVG.blk,
    oppFgPct:  meanOf(opps.map(t => t.oppFgPct))  ?? 0.435,
    oppFg3Pct: meanOf(opps.map(t => t.oppFg3Pct)) ?? 0.335,
    pace:      meanOf(advs.map(t => t.pace))      ?? WNBA_LEAGUE_AVG.pace,
    offRating: meanOf(advs.map(t => t.offRating)) ?? 100,
    defRating: meanOf(advs.map(t => t.defRating)) ?? 100,
  };
}

// ── SEASON DETECTION ─────────────────────────────────────────────────────────
function getActiveSeason() {
  const m = new Date().getMonth() + 1;
  return m >= 5 ? new Date().getFullYear() : new Date().getFullYear() - 1;
}
const ACTIVE_SEASON = getActiveSeason(); // 2026
const WNBA_SEASON_START = '2026-05-08'; // First day of 2026 regular season

// ── 2026 WNBA PROJECTIONS ────────────────────────────────────────────────────
// Columns: n=name, t=team, pos=position, min, fg3m, reb, ast, stl, blk, pts
const PROJ_2026 = [
  {n:"A'ja Wilson",         t:"LV",  pos:"F", min:31.7, fg3m:0.5, reb:10.5, ast:2.7, stl:1.6, blk:2.2, pts:23.5},
  {n:"Caitlin Clark",       t:"IND", pos:"G", min:33.7, fg3m:2.7, reb:5.4,  ast:8.9, stl:1.5, blk:0.7, pts:18.5},
  {n:"Napheesa Collier",    t:"MIN", pos:"F", min:32.5, fg3m:1.1, reb:9.3,  ast:3.1, stl:1.7, blk:1.3, pts:20.9},
  {n:"Alyssa Thomas",       t:"PHX", pos:"F", min:31.7, fg3m:0.0, reb:9.7,  ast:8.1, stl:1.6, blk:0.3, pts:13.7},
  {n:"Breanna Stewart",     t:"NY",  pos:"F", min:31.3, fg3m:1.0, reb:7.6,  ast:3.4, stl:1.4, blk:1.3, pts:18.1},
  {n:"Angel Reese",         t:"ATL", pos:"F", min:32.2, fg3m:0.1, reb:12.9, ast:3.6, stl:1.5, blk:0.5, pts:14.6},
  {n:"Paige Bueckers",      t:"DAL", pos:"G", min:33.1, fg3m:1.3, reb:4.0,  ast:5.7, stl:1.7, blk:0.7, pts:19.4},
  {n:"Aliyah Boston",       t:"IND", pos:"F", min:30.7, fg3m:0.1, reb:8.6,  ast:3.6, stl:1.1, blk:1.0, pts:14.7},
  {n:"Dearica Hamby",       t:"LA",  pos:"F", min:30.4, fg3m:0.5, reb:7.9,  ast:3.0, stl:1.4, blk:0.5, pts:16.9},
  {n:"Kelsey Plum",         t:"LA",  pos:"G", min:34.7, fg3m:2.6, reb:3.0,  ast:5.0, stl:1.1, blk:0.1, pts:19.3},
  {n:"Sabrina Ionescu",     t:"NY",  pos:"G", min:31.9, fg3m:2.6, reb:5.2,  ast:5.9, stl:1.2, blk:0.3, pts:18.8},
  {n:"Nneka Ogwumike",      t:"LA",  pos:"F", min:30.9, fg3m:0.9, reb:7.4,  ast:2.3, stl:1.6, blk:0.4, pts:16.0},
  {n:"Skylar Diggins",      t:"CHI", pos:"G", min:31.4, fg3m:1.3, reb:2.7,  ast:6.1, stl:1.4, blk:1.0, pts:15.5},
  {n:"Jackie Young",        t:"LV",  pos:"G", min:31.1, fg3m:1.9, reb:4.6,  ast:5.1, stl:1.1, blk:0.2, pts:16.3},
  {n:"Kelsey Mitchell",     t:"IND", pos:"G", min:31.7, fg3m:2.5, reb:2.0,  ast:2.8, stl:0.8, blk:0.2, pts:20.1},
  {n:"Allisha Gray",        t:"ATL", pos:"G", min:33.9, fg3m:2.0, reb:5.0,  ast:3.2, stl:1.1, blk:0.5, pts:17.3},
  {n:"Sonia Citron",        t:"WSH", pos:"G", min:32.4, fg3m:2.0, reb:4.4,  ast:2.7, stl:1.4, blk:0.6, pts:16.2},
  {n:"Arike Ogunbowale",    t:"DAL", pos:"G", min:34.4, fg3m:2.4, reb:3.2,  ast:4.2, stl:1.8, blk:0.2, pts:18.8},
  {n:"Courtney Williams",   t:"MIN", pos:"G", min:28.2, fg3m:1.2, reb:5.0,  ast:6.1, stl:1.0, blk:0.3, pts:12.9},
  {n:"Rhyne Howard",        t:"ATL", pos:"G", min:34.5, fg3m:3.0, reb:4.6,  ast:3.0, stl:1.5, blk:0.7, pts:17.9},
  {n:"Satou Sabally",       t:"NY",  pos:"F", min:28.8, fg3m:1.8, reb:6.2,  ast:3.6, stl:1.4, blk:0.4, pts:16.7},
  {n:"Azura Stevens",       t:"CHI", pos:"F", min:27.0, fg3m:1.6, reb:7.7,  ast:2.1, stl:1.1, blk:1.2, pts:12.6},
  {n:"Kiki Iriafen",        t:"WSH", pos:"F", min:27.6, fg3m:0.1, reb:8.9,  ast:0.8, stl:1.0, blk:0.3, pts:14.2},
  {n:"Tina Charles",        t:"CON", pos:"C", min:29.7, fg3m:0.3, reb:6.4,  ast:2.0, stl:0.8, blk:0.5, pts:15.6},
  {n:"Brionna Jones",       t:"ATL", pos:"C", min:26.6, fg3m:0.2, reb:6.6,  ast:2.0, stl:1.2, blk:0.6, pts:13.0},
  {n:"Gabby Williams",      t:"GS",  pos:"F", min:31.8, fg3m:1.1, reb:4.5,  ast:4.2, stl:2.1, blk:0.5, pts:11.4},
  {n:"Jonquel Jones",       t:"NY",  pos:"F", min:27.2, fg3m:1.2, reb:8.6,  ast:2.8, stl:0.6, blk:1.2, pts:12.8},
  {n:"Kamilla Cardoso",     t:"CHI", pos:"C", min:27.7, fg3m:0.0, reb:8.7,  ast:1.2, stl:0.6, blk:0.4, pts:13.4},
  {n:"Kayla Thornton",      t:"GS",  pos:"F", min:28.8, fg3m:1.6, reb:6.0,  ast:1.2, stl:1.0, blk:0.4, pts:11.2},
  {n:"Alanna Smith",        t:"DAL", pos:"F", min:26.5, fg3m:0.4, reb:5.5,  ast:3.0, stl:1.4, blk:1.8, pts:10.2},
  {n:"Chelsea Gray",        t:"LV",  pos:"G", min:30.6, fg3m:1.3, reb:3.9,  ast:5.9, stl:1.5, blk:0.8, pts:11.8},
  {n:"Veronica Burton",     t:"GS",  pos:"G", min:29.1, fg3m:1.3, reb:4.1,  ast:5.5, stl:1.3, blk:0.6, pts:10.5},
  {n:"Ezi Magbegor",        t:"SEA", pos:"C", min:28.4, fg3m:0.4, reb:7.0,  ast:1.2, stl:0.8, blk:2.1, pts:9.5},
  {n:"Kahleah Copper",      t:"PHX", pos:"G", min:28.6, fg3m:1.9, reb:3.8,  ast:1.9, stl:0.9, blk:0.2, pts:17.6},
  {n:"Shakira Austin",      t:"WSH", pos:"C", min:22.9, fg3m:0.1, reb:7.1,  ast:1.7, stl:1.3, blk:1.1, pts:13.1},
  {n:"Ariel Atkins",        t:"LA",  pos:"G", min:29.2, fg3m:1.5, reb:3.4,  ast:3.4, stl:1.5, blk:0.6, pts:14.0},
  {n:"Marina Mabrey",       t:"TOR", pos:"G", min:31.1, fg3m:2.2, reb:4.3,  ast:4.2, stl:1.0, blk:0.4, pts:14.6},
  {n:"Natasha Howard",      t:"MIN", pos:"F", min:27.8, fg3m:0.4, reb:7.1,  ast:2.1, stl:1.5, blk:0.4, pts:13.6},
  {n:"Rickea Jackson",      t:"LA",  pos:"F", min:31.2, fg3m:1.8, reb:4.0,  ast:1.6, stl:0.7, blk:0.4, pts:15.5},
  {n:"Kayla McBride",       t:"MIN", pos:"G", min:31.4, fg3m:2.5, reb:2.4,  ast:3.3, stl:1.2, blk:0.1, pts:14.4},
  {n:"Jordin Canada",       t:"ATL", pos:"G", min:29.5, fg3m:0.9, reb:3.2,  ast:5.8, stl:1.6, blk:0.2, pts:11.4},
  {n:"Natasha Cloud",       t:"NY",  pos:"G", min:29.7, fg3m:1.2, reb:3.8,  ast:5.8, stl:1.2, blk:0.5, pts:10.2},
  {n:"Jewell Loyd",         t:"LV",  pos:"G", min:29.2, fg3m:2.1, reb:3.3,  ast:2.1, stl:1.1, blk:0.2, pts:13.8},
  {n:"Brittney Sykes",      t:"TOR", pos:"G", min:30.4, fg3m:0.9, reb:3.2,  ast:2.4, stl:1.3, blk:0.3, pts:14.6},
  {n:"Elizabeth Williams",  t:"CHI", pos:"C", min:23.4, fg3m:0.0, reb:5.8,  ast:1.8, stl:1.0, blk:1.2, pts:9.0},
  {n:"Brittney Griner",     t:"CON", pos:"C", min:25.1, fg3m:0.1, reb:6.2,  ast:1.4, stl:0.4, blk:1.5, pts:12.6},
  {n:"Janelle Salaün",      t:"GS",  pos:"F", min:27.8, fg3m:1.8, reb:5.8,  ast:1.1, stl:0.7, blk:0.1, pts:12.1},
  {n:"Anesah Morrow",       t:"CON", pos:"F", min:21.3, fg3m:0.7, reb:7.4,  ast:0.7, stl:0.5, blk:0.6, pts:9.6},
  {n:"Saniya Rivers",       t:"CON", pos:"G", min:27.6, fg3m:0.5, reb:3.4,  ast:2.8, stl:1.5, blk:0.7, pts:13.6},
  {n:"Maddy Siegrist",      t:"DAL", pos:"F", min:26.7, fg3m:0.9, reb:4.3,  ast:1.0, stl:0.7, blk:0.5, pts:12.1},
  {n:"DeWanna Bonner",      t:"PHX", pos:"F", min:27.3, fg3m:1.4, reb:5.0,  ast:1.6, stl:1.0, blk:0.4, pts:13.8},
  {n:"Naz Hillmon",         t:"ATL", pos:"F", min:24.7, fg3m:0.7, reb:6.0,  ast:2.0, stl:0.6, blk:0.4, pts:7.5},
  {n:"Erica Wheeler",       t:"SEA", pos:"G", min:25.7, fg3m:1.3, reb:2.8,  ast:2.8, stl:1.1, blk:0.2, pts:9.1},
  {n:"Cameron Brink",       t:"LA",  pos:"F", min:22.7, fg3m:0.9, reb:7.2,  ast:1.4, stl:1.0, blk:2.6, pts:8.6},
  {n:"Courtney Vandersloot",t:"PHX", pos:"G", min:26.2, fg3m:0.8, reb:3.2,  ast:5.5, stl:1.5, blk:0.4, pts:9.1},
  {n:"Bridget Carleton",    t:"POR", pos:"F", min:28.4, fg3m:1.7, reb:3.7,  ast:1.9, stl:0.8, blk:0.3, pts:7.5},
  {n:"Cheyenne Parker-Tyus",t:"LV",  pos:"F", min:21.2, fg3m:0.3, reb:5.3,  ast:1.7, stl:0.8, blk:0.7, pts:10.7},
  {n:"Jessica Shepard",     t:"DAL", pos:"F", min:22.1, fg3m:0.0, reb:6.9,  ast:4.2, stl:0.4, blk:0.1, pts:7.0},
  {n:"Leonie Fiebich",      t:"NY",  pos:"F", min:26.9, fg3m:1.6, reb:3.6,  ast:1.9, stl:1.1, blk:0.3, pts:8.4},
  {n:"NaLyssa Smith",       t:"LV",  pos:"F", min:22.2, fg3m:0.2, reb:5.5,  ast:0.8, stl:0.6, blk:0.7, pts:8.7},
  {n:"Myisha Hines-Allen",  t:"IND", pos:"F", min:19.6, fg3m:0.5, reb:5.1,  ast:2.7, stl:0.7, blk:0.3, pts:7.5},
  {n:"Sami Whitcomb",       t:"PHX", pos:"G", min:21.4, fg3m:1.8, reb:3.1,  ast:2.3, stl:0.7, blk:0.2, pts:7.9},
  {n:"Tiffany Hayes",       t:"ATL", pos:"G", min:25.9, fg3m:1.4, reb:3.5,  ast:2.7, stl:0.8, blk:0.1, pts:11.2},
  {n:"Natisha Hiedeman",    t:"SEA", pos:"G", min:17.2, fg3m:0.9, reb:1.6,  ast:2.6, stl:0.7, blk:0.1, pts:7.1},
  {n:"Aziaha James",        t:"DAL", pos:"G", min:18.2, fg3m:0.9, reb:3.2,  ast:1.7, stl:0.6, blk:0.2, pts:9.1},
  {n:"DiJonai Carrington",  t:"CHI", pos:"G", min:19.9, fg3m:0.8, reb:3.4,  ast:1.4, stl:1.2, blk:0.4, pts:9.5},
  {n:"Sophie Cunningham",   t:"IND", pos:"G", min:26.3, fg3m:1.7, reb:3.8,  ast:1.4, stl:1.0, blk:0.2, pts:8.6},
  {n:"Temi Fagbenle",       t:"GS",  pos:"C", min:20.7, fg3m:0.2, reb:4.6,  ast:1.3, stl:0.7, blk:0.7, pts:7.1},
  {n:"Rachel Banham",       t:"CHI", pos:"G", min:19.6, fg3m:1.7, reb:1.0,  ast:2.2, stl:0.5, blk:0.2, pts:7.4},
  {n:"Dominique Malonga",   t:"SEA", pos:"C", min:21.7, fg3m:0.2, reb:7.4,  ast:1.4, stl:0.6, blk:1.1, pts:12.0},
  {n:"Rebecca Allen",       t:"NY",  pos:"F", min:21.2, fg3m:1.2, reb:3.1,  ast:1.2, stl:0.7, blk:0.8, pts:6.4},
  {n:"Teaira McCowan",      t:"PA",  pos:"C", min:17.8, fg3m:0.0, reb:6.2,  ast:1.0, stl:0.4, blk:0.7, pts:8.4},
  {n:"Olivia Nelson-Ododa", t:"CON", pos:"F", min:19.2, fg3m:0.0, reb:4.3,  ast:0.6, stl:0.6, blk:1.0, pts:6.5},
  {n:"Natasha Mack",        t:"PHX", pos:"F", min:17.4, fg3m:0.0, reb:5.6,  ast:1.0, stl:0.8, blk:1.4, pts:4.5},
  {n:"Monique Billings",    t:"CON", pos:"F", min:18.9, fg3m:0.2, reb:4.9,  ast:0.9, stl:0.6, blk:0.6, pts:6.6},
  {n:"Kia Nurse",           t:"CHI", pos:"G", min:20.9, fg3m:1.3, reb:2.0,  ast:1.3, stl:0.3, blk:0.1, pts:7.0},
  {n:"Odyssey Sims",        t:"IND", pos:"G", min:20.1, fg3m:1.3, reb:2.0,  ast:4.4, stl:0.9, blk:0.1, pts:9.7},
  {n:"Stefanie Dolson",     t:"WSH", pos:"C", min:17.7, fg3m:0.9, reb:3.1,  ast:1.7, stl:0.3, blk:0.4, pts:5.7},
  {n:"Sug Sutton",          t:"POR", pos:"G", min:23.2, fg3m:0.7, reb:1.7,  ast:3.6, stl:0.8, blk:0.0, pts:5.2},
  {n:"Dana Evans",          t:"LV",  pos:"G", min:18.4, fg3m:0.9, reb:1.1,  ast:2.3, stl:0.4, blk:0.1, pts:6.8},
  {n:"Lexie Hull",          t:"IND", pos:"G", min:20.6, fg3m:0.8, reb:3.0,  ast:1.3, stl:0.9, blk:0.2, pts:5.0},
  {n:"Marine Johannes",     t:"NY",  pos:"G", min:18.5, fg3m:1.5, reb:1.7,  ast:1.7, stl:0.7, blk:0.1, pts:6.6},
  {n:"Emily Engstler",      t:"POR", pos:"F", min:13.3, fg3m:0.5, reb:3.6,  ast:1.4, stl:0.6, blk:0.7, pts:4.3},
  {n:"Aaliyah Edwards",     t:"CON", pos:"F", min:17.4, fg3m:0.0, reb:4.4,  ast:0.7, stl:0.8, blk:0.6, pts:5.8},
  {n:"Kate Martin",         t:"GS",  pos:"G", min:17.9, fg3m:1.4, reb:2.8,  ast:1.5, stl:0.4, blk:0.2, pts:6.2},
  {n:"Leila Lacan",         t:"CON", pos:"G", min:23.7, fg3m:0.5, reb:1.9,  ast:3.0, stl:1.6, blk:0.1, pts:7.2},
  {n:"Jacy Sheldon",        t:"CHI", pos:"G", min:22.7, fg3m:1.0, reb:2.2,  ast:2.1, stl:0.7, blk:0.2, pts:6.7},
  {n:"Alysha Clark",        t:"WSH", pos:"F", min:21.8, fg3m:0.9, reb:3.2,  ast:1.4, stl:0.7, blk:0.1, pts:4.9},
  {n:"Nia Coffey",          t:"MIN", pos:"F", min:12.1, fg3m:0.5, reb:2.7,  ast:1.0, stl:1.0, blk:0.6, pts:3.9},
  {n:"Aari McDonald",       t:"IND", pos:"G", min:23.7, fg3m:1.1, reb:2.1,  ast:4.1, stl:1.0, blk:0.1, pts:8.9},
  {n:"Diamond Miller",      t:"CON", pos:"G", min:17.3, fg3m:0.4, reb:1.8,  ast:1.7, stl:0.7, blk:0.3, pts:6.1},
  {n:"Stephanie Talbot",    t:"LV",  pos:"F", min:15.1, fg3m:0.4, reb:2.8,  ast:1.5, stl:0.5, blk:0.2, pts:3.8},
  {n:"Isabelle Harrison",   t:"TOR", pos:"F", min:12.4, fg3m:0.1, reb:3.0,  ast:0.8, stl:0.5, blk:0.2, pts:5.3},
  {n:"Michaela Onyenwere",  t:"WSH", pos:"F", min:17.3, fg3m:0.6, reb:2.0,  ast:1.0, stl:0.4, blk:0.3, pts:6.0},
  {n:"Kalani Brown",        t:"PHX", pos:"C", min:12.9, fg3m:0.1, reb:3.7,  ast:0.7, stl:0.2, blk:0.6, pts:5.2},
  {n:"Rae Burrell",         t:"LA",  pos:"G", min:17.3, fg3m:0.7, reb:2.1,  ast:1.2, stl:0.7, blk:0.2, pts:6.4},
  {n:"Nyara Sabally",       t:"TOR", pos:"F", min:17.2, fg3m:1.0, reb:4.7,  ast:0.6, stl:0.6, blk:0.9, pts:5.5},
  {n:"Sevgi Uzun",          t:"CHI", pos:"G", min:30.0, fg3m:0.5, reb:2.2,  ast:4.4, stl:1.1, blk:0.4, pts:5.8},
  {n:"Tyasha Harris",       t:"DAL", pos:"G", min:15.8, fg3m:0.8, reb:0.8,  ast:1.9, stl:1.0, blk:0.2, pts:4.9},
  {n:"Megan Gustafson",     t:"POR", pos:"C", min:11.0, fg3m:0.5, reb:2.0,  ast:0.2, stl:0.2, blk:0.0, pts:2.9},
];

// ── TEAM META ────────────────────────────────────────────────────────────────
const TEAM_META = {
  ATL: { full: "Atlanta Dream",          color: "#c8102e" },
  CHI: { full: "Chicago Sky",            color: "#418fde" },
  CON: { full: "Connecticut Sun",        color: "#f47920" },
  DAL: { full: "Dallas Wings",           color: "#c4d600" },
  GS:  { full: "Golden State Valkyries", color: "#ffc72c" },
  IND: { full: "Indiana Fever",          color: "#002d62" },
  LA:  { full: "Los Angeles Sparks",     color: "#702f8a" },
  LV:  { full: "Las Vegas Aces",         color: "#b22222" },
  MIN: { full: "Minnesota Lynx",         color: "#236192" },
  NY:  { full: "New York Liberty",       color: "#86cebc" },
  PA:  { full: "Philadelphia",           color: "#003594" },
  PHX: { full: "Phoenix Mercury",        color: "#cb6015" },
  POR: { full: "Portland",              color: "#c8102e" },
  SEA: { full: "Seattle Storm",          color: "#2c5234" },
  TOR: { full: "Toronto Tempo",          color: "#b40e2b" },
  WSH: { full: "Washington Mystics",     color: "#e03a3e" },
};

// ── UTILITIES ────────────────────────────────────────────────────────────────
function normalizeName(n) {
  return (n || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
}

function calcHitRate(logs, statKey, line) {
  if (!logs || logs.length === 0) return null;
  const hits = logs.filter(g => (g[statKey] ?? 0) >= line).length;
  return Math.round((hits / logs.length) * 100);
}

function avg(logs, statKey) {
  if (!logs || logs.length === 0) return null;
  const vals = logs.map(g => g[statKey] ?? 0);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function fmt1(v) { return v == null ? "--" : Number(v).toFixed(1); }
function fmtPct(v) { return v == null ? "--" : v + "%"; }

function pctColor(pct) {
  if (pct == null) return "#7a8fa8";
  if (pct >= 70) return "#4ade80";
  if (pct >= 50) return "#fbbf24";
  return "#f87171";
}

function edgeLabel(proj, recent) {
  if (recent == null) return null;
  const diff = recent - proj;
  const pct = Math.abs(diff) / proj;
  if (pct < 0.05) return null;
  return { dir: diff > 0 ? "over" : "under", pct: Math.round(pct * 100) };
}

// ── PREDICTION MODEL ──────────────────────────────────────────────────────────

// Abramowitz & Stegun normal CDF approximation
function normalCDF(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return (1 + sign * y) / 2;
}

// Poisson P(X >= k)
function poissonGTE(lambda, k) {
  if (lambda <= 0) return k <= 0 ? 1 : 0;
  const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880];
  let cum = 0;
  for (let i = 0; i < Math.min(k, 20); i++) {
    const f = i < FACT.length ? FACT[i] : FACT[FACT.length - 1];
    cum += Math.pow(lambda, i) * Math.exp(-lambda) / f;
  }
  return Math.max(0, Math.min(1, 1 - cum));
}

// Probability → fair American odds
function probToAmericanOdds(prob) {
  if (!prob || prob <= 0 || prob >= 1) return null;
  if (prob >= 0.5) return Math.round(-(prob / (1 - prob)) * 100);
  return Math.round(((1 - prob) / prob) * 100);
}

// Sample standard deviation
function sampleStdDev(arr) {
  if (!arr || arr.length < 3) return null;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.map(x => (x - m) ** 2).reduce((a, b) => a + b, 0) / (arr.length - 1));
}

// Recency-weighted mean over a NEWEST-FIRST array. Weights decay by an exponential
// half-life of RECENCY_HL games so the blend tracks a player's current role/form
// instead of lagging a flat season-long average. Backtested on 2026: a rising-role
// player's mean registers ~1-3 pts higher than the flat mean, matching the market.
const RECENCY_HL = 8;
function recencyMean(vals) {
  if (!vals || !vals.length) return null;
  let sw = 0, swv = 0;
  for (let i = 0; i < vals.length; i++) { const w = Math.pow(0.5, i / RECENCY_HL); sw += w; swv += w * vals[i]; }
  return swv / sw;
}

// Standard WNBA prop lines used by PrizePicks / sportsbooks
const WNBA_LINES = {
  pts:  [7.5, 9.5, 11.5, 13.5, 15.5, 17.5, 19.5, 21.5, 23.5, 25.5, 27.5],
  reb:  [3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5],
  ast:  [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5],
  fg3m: [0.5, 1.5, 2.5, 3.5],
  pra:  [13.5, 15.5, 17.5, 19.5, 21.5, 23.5, 25.5, 27.5, 29.5, 31.5, 33.5, 35.5],
  sb:   [1.5, 2.5, 3.5],
};

// Public build: illustrative variance and calibration constants. The fitted
// production values are private.
// Game-to-game spread as a fraction of the projection, with a floor.
const SIGMA_COEFF = { pts: 0.45, reb: 0.45, ast: 0.55, pra: 0.35 };
const SIGMA_FLOOR = { pts: 2.5, reb: 1.5, ast: 1.2, pra: 3.0 };
// Per-stat trim on the preseason projection (1 = none).
const PRIOR_CAL = {};

// "Over 3.5" and ">= 4" are the same event, so P(over) = 1 - Phi((line - proj)/sigma)
// with no extra half-step.
const CONTINUITY = 0;

// P(over line) — Normal for continuous stats, Poisson for rare counts
function pOverLine(modelProj, line, statId, sigma) {
  if (!modelProj || modelProj <= 0) return null;
  if (statId === 'fg3m' || statId === 'sb') {
    return poissonGTE(modelProj, Math.ceil(line));
  }
  const z = (line + CONTINUITY - modelProj) / Math.max(sigma, 0.5);
  return Math.max(0, Math.min(1, 1 - normalCDF(z)));
}

// 2025 WNBA league averages (per team per game) — used for opponent adjustment
const WNBA_LEAGUE_AVG = { pts: 83.2, reb: 35.1, ast: 19.8, fg3m: 8.2, stl: 6.8, blk: 4.5, pace: 97.5 };

// ESPN team IDs (stable across seasons)
const TEAM_ESPN_IDS = {
  ATL: 20, CHI: 19, CON: 18, DAL: 3,  GS: 129689,
  IND: 5,  LV: 17,  LA: 6,  MIN: 8,  NY: 9,
  PHX: 11, POR: 132052, SEA: 14, TOR: 131935, WSH: 16,
};

// Clamp a multiplier to a reasonable range and return 1.0 if trivially small
function clampMult(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ── Projection model (public reference implementation) ──────────────────────
// The production model (minutes-role scaling, matchup and pace multipliers, a
// variance profile from advanced stats, and their calibration) is private. This
// stand-in keeps the same inputs and output shape so the board, player panel
// and ledger render unchanged:
//
//   baseProj  = Bayesian blend of the preseason projection and recency-weighted
//               game logs (the prior is worth REGRESSION_GAMES games)
//   matchup   = opponent points allowed vs league average, clamped to ±6%
//   pricing   = Normal for pts/reb/ast/pra, Poisson for threes and stocks
const REGRESSION_GAMES = 8;

function buildWNBAModel(player, logs, propCfg, matchup = null, espnTeamStats = {}, seasonAvg = null, ctx = {}) {
  const statId = propCfg.id;
  const rawProj = propCfg.combo ? propCfg.projFn(player) : player[propCfg.key];
  const getVal = (g) => propCfg.combo ? getComboVal(g, propCfg.keys) : (g[propCfg.key] ?? 0);

  const vals = logs ? logs.slice(0, 30).map(getVal) : [];
  const gp = vals.length;
  const projLine = (rawProj ?? 0) * (PRIOR_CAL[statId] ?? 1);
  const recentMins = logs ? logs.slice(0, 30).map(g => g.min).filter(m => m != null && m > 0) : [];
  const recentMin = recencyMean(recentMins);

  // Season average stands in for logs when none are loaded yet.
  const saVal = seasonAvg?.[propCfg.key] ?? null;
  const obsMean = gp > 0 ? recencyMean(vals) : saVal;
  const effectiveGP = gp > 0 ? gp : (saVal != null ? Math.min(seasonAvg?.gp ?? 5, 10) : 0);
  const dataWeight = effectiveGP / (effectiveGP + REGRESSION_GAMES);
  const baseProj = obsMean != null ? projLine * (1 - dataWeight) + obsMean * dataWeight : projLine;

  const factors = [];
  let adj = baseProj;
  const allowed = matchup?.opponent ? ctx?.teamOpponent?.[matchup.opponent]?.oppPts ?? null : null;
  const leaguePts = ctx?.leagueAvg?.oppPts ?? WNBA_LEAGUE_AVG.pts;
  if (allowed != null && (statId === 'pts' || statId === 'pra')) {
    const mult = clampMult(allowed / leaguePts, 0.94, 1.06);
    adj *= mult;
    factors.push({ label: "Opp defense", mult, detail: fmt1(allowed) + " allowed/g" });
  }
  const finalProj = adj;

  const coeff = SIGMA_COEFF[statId] ?? 0.40;
  const floor = SIGMA_FLOOR[statId] ?? 1.5;
  const sigma = Math.max(floor, finalProj * coeff);

  const lines = WNBA_LINES[statId] ?? WNBA_LINES.pra;
  let bestLine = null, bestProb = null, minDist = Infinity;
  for (const l of lines) {
    const p = pOverLine(finalProj, l, statId, sigma);
    if (p == null) continue;
    const d = Math.abs(p - 0.5);
    if (p >= 0.38 && p <= 0.68 && d < minDist) { minDist = d; bestLine = l; bestProb = p; }
  }
  // Off the end of the ladder: still price the nearest line so the row renders,
  // but flag it so the board ranks it below real prices.
  const bestInWindow = bestLine != null;
  if (!bestLine) {
    for (const l of lines) {
      const p = pOverLine(finalProj, l, statId, sigma);
      if (p == null) continue;
      if (Math.abs(p - 0.5) < minDist) { minDist = Math.abs(p - 0.5); bestLine = l; bestProb = p; }
    }
  }
  const ladder = lines.map(l => ({
    line: l,
    prob: pOverLine(finalProj, l, statId, sigma),
    fairOdds: probToAmericanOdds(pOverLine(finalProj, l, statId, sigma)),
  }));

  const edge = bestProb != null ? Math.abs(bestProb - 0.5) : 0;
  return {
    projLine,
    priorAnchor: projLine,
    minsMult: 1,
    recentMin,
    baseProj,
    modelProj: finalProj,
    delta: finalProj - projLine,
    sigma,
    gp: effectiveGP,
    usingSeasonAvg: gp === 0 && effectiveGP > 0,
    dataWeight,
    factors,
    bestLine,
    bestProb,
    // Rank the side the model is on: winProb = max(p, 1 - p).
    winProb: bestProb != null ? Math.max(bestProb, 1 - bestProb) : null,
    bestSide: sideOf(bestProb),
    bestInWindow,
    fairOdds: bestProb != null ? probToAmericanOdds(Math.max(bestProb, 1 - bestProb)) : null,
    confidence: edge >= 0.15 ? 'high' : edge >= 0.07 ? 'medium' : 'low',
    sigmaProfileMult: 1,
    gravity: null,
    ladder,
  };
}

function fmtOdds(v) {
  if (v == null) return "--";
  return v > 0 ? `+${v}` : String(v);
}

function oddsColor(v) {
  if (v == null) return "#7a8fa8";
  if (v <= -150) return "#4ade80";  // strong fav → high probability
  if (v <= -110) return "#86efac";
  if (v <= 110)  return "#fbbf24";  // near even
  return "#f87171";                  // long shot
}

// Confidence is TWO-SIDED — it scores |P(over) − 50%|, so a 14% P(over) earns the
// same HIGH badge as an 86% one. Without a direction marker the column reads as
// "strong over" on rows that are in fact strong unders. The arrow is the side the
// model is actually on; the tier colour still carries the strength.
function sideOf(prob) {
  if (prob == null) return null;
  return prob >= 0.5 ? 'over' : 'under';
}
function sideArrow(prob) {
  const s = sideOf(prob);
  return s === 'over' ? '↑' : s === 'under' ? '↓' : '';
}
// One colour for the side marker everywhere it appears (Win% cell, Conf badge),
// so O/U never means two different colours in the same row.
function sideColor(side) {
  return side === 'over' ? "#4ade80" : side === 'under' ? "#f87171" : "#7a8fa8";
}

// Win probability = P(the side we're on), so it lives in [0.5, 1]. pctColor's
// 50/70 breaks are tuned for P(over) in [0,1] and would paint every under amber.
// These breaks mirror the confidence tiers: ≥15pp edge → green, ≥7pp → amber.
function winProbColor(pct) {
  if (pct == null) return "#7a8fa8";
  if (pct >= 65) return "#4ade80";
  if (pct >= 57) return "#fbbf24";
  return "#7a8fa8";                  // coin-flip territory — no signal to colour
}

// Confidence badge style
function confStyle(conf) {
  if (conf === 'high')   return { color: "#4ade80", bg: "rgba(74,222,128,0.12)", border: "rgba(74,222,128,0.25)" };
  if (conf === 'medium') return { color: "#fbbf24", bg: "rgba(251,191,36,0.12)", border: "rgba(251,191,36,0.25)" };
  return                          { color: "#7a8fa8", bg: "rgba(120,143,168,0.10)", border: "rgba(120,143,168,0.2)" };
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
}

// ── ESPN TEAM STATS (offensive / defensive proxies) ──────────────────────────
// Returns { [abbr]: { avgPts, avgReb, avgAst, avg3pm, avgStl, avgBlk } }
async function fetchWNBAESPNTeamStats() {
  const results = {};
  await Promise.allSettled(
    Object.entries(TEAM_ESPN_IDS).map(async ([abbr, id]) => {
      try {
        const data = await cacheFetch(`${ESPN_BASE}/teams/${id}/statistics`, 3_600_000);
        const cats = data?.results?.stats?.categories || [];
        const getStat = (catName, statName) => {
          const cat = cats.find(c => c.name === catName);
          const s   = cat?.stats?.find(st => st.name === statName);
          return s?.value != null ? parseFloat(s.value) : null;
        };
        results[abbr] = {
          avgPts: getStat('offensive', 'avgPoints'),
          avgReb: getStat('general',  'avgRebounds'),
          avgAst: getStat('offensive', 'avgAssists'),
          avg3pm: getStat('offensive', 'avgThreePointFieldGoalsMade'),
          avgStl: getStat('defensive', 'avgSteals'),
          avgBlk: getStat('defensive', 'avgBlocks'),
        };
      } catch {}
    })
  );
  return results;
}

// ── ESPN PLAYER 2025 SEASON AVERAGES ─────────────────────────────────────────
// Fetches real 2025 per-game stats for each player in PROJ_2026.
// Returns { [normName]: { gp, pts, reb, ast, fg3m, stl, blk } }
async function fetchWNBAPlayerSeasonAvgs() {
  // Build name → ESPN athlete ID from all rosters in parallel
  const nameToId = {};
  await Promise.allSettled(
    Object.values(TEAM_ESPN_IDS).map(async id => {
      try {
        const data = await cacheFetch(`${ESPN_BASE}/teams/${id}/roster`, 3_600_000);
        for (const a of (data.athletes || [])) {
          const name = a.fullName || a.displayName;
          if (a.id && name) nameToId[normalizeName(name)] = a.id;
        }
      } catch {}
    })
  );

  const results = {};
  await Promise.allSettled(
    PROJ_2026.map(async p => {
      const normName   = normalizeName(p.n);
      const athleteId  = nameToId[normName];
      if (!athleteId) return;
      try {
        const url  = `${ESPN_CORE}/seasons/2025/types/2/athletes/${athleteId}/statistics/0`;
        const data = await cacheFetch(url, 3_600_000);
        const cats = data?.splits?.categories || [];
        const getStat = (catName, statName) => {
          const cat = cats.find(c => c.name === catName);
          const s   = cat?.stats?.find(st => st.name === statName);
          return s?.value ?? null;
        };
        const gp = getStat('general', 'gamesPlayed');
        if (!gp || gp < 3) return;
        results[normName] = {
          gp:   Math.round(gp),
          pts:  getStat('offensive', 'avgPoints'),
          reb:  getStat('general',  'avgRebounds'),
          ast:  getStat('offensive', 'avgAssists'),
          fg3m: getStat('offensive', 'avgThreePointFieldGoalsMade'),
          fg3a: getStat('offensive', 'avgThreePointFieldGoalsAttempted'),
          stl:  getStat('defensive', 'avgSteals'),
          blk:  getStat('defensive', 'avgBlocks'),
        };
      } catch {}
    })
  );
  return results;
}

// ── ESPN DATA FETCHERS ───────────────────────────────────────────────────────

async function fetchSchedule(dateStr) {
  const url = `${ESPN_BASE}/scoreboard?dates=${dateStr}&limit=20`;
  const data = await cacheFetch(url, 300_000);
  return (data.events || []).map(ev => ({
    id: ev.id,
    name: ev.name,
    shortName: ev.shortName,
    date: ev.date,
    status: ev.status?.type?.description || "",
    statusState: ev.status?.type?.state || "pre",
    home: ev.competitions?.[0]?.competitors?.find(c => c.homeAway === "home"),
    away: ev.competitions?.[0]?.competitors?.find(c => c.homeAway === "away"),
  }));
}

async function fetchAllTeams() {
  const data = await cacheFetch(`${ESPN_BASE}/teams?limit=30`, 3_600_000);
  return (data.sports?.[0]?.leagues?.[0]?.teams || []).map(t => ({
    id: t.team.id,
    abbrev: t.team.abbreviation,
    name: t.team.displayName,
    logo: t.team.logos?.[0]?.href,
  }));
}

async function fetchTeamRoster(espnTeamId) {
  const url = `${ESPN_BASE}/teams/${espnTeamId}/roster`;
  try {
    const data = await cacheFetch(url, 3_600_000);
    // WNBA roster returns athletes as a flat array (not grouped under .items)
    return (data.athletes || []).map(a => ({
      id: a.id,
      name: a.fullName || a.displayName,
      injuryStatus: a.injuries?.[0]?.status || null,
      injuryDetail: a.injuries?.[0]?.details?.shortName || a.injuries?.[0]?.shortName || null,
    }));
  } catch {
    return [];
  }
}

// Auto-preload game logs for all players on tonight's slate so the model
// uses real data without requiring the user to expand each row manually.
async function preloadTodayLogs(todayTeams, espnTeams, setLogCache) {
  const players = PROJ_2026.filter(p => todayTeams.has(p.t));
  await Promise.allSettled(
    players.map(async (player) => {
      try {
        const team = espnTeams.find(t => t.abbrev === player.t);
        if (!team) return;
        const roster = await fetchTeamRoster(team.id);
        const norm = normalizeName(player.n);
        const match = roster.find(a =>
          normalizeName(a.name) === norm ||
          normalizeName(a.name).split(" ").slice(-1)[0] === norm.split(" ").slice(-1)[0]
        );
        if (!match) return;
        let gameLogs = await fetchPlayerGameLog(match.id, ACTIVE_SEASON);
        let season = ACTIVE_SEASON;
        if (gameLogs.length === 0) {
          gameLogs = await fetchPlayerGameLog(match.id, ACTIVE_SEASON - 1);
          season = ACTIVE_SEASON - 1;
        }
        setLogCache(prev => {
          if (prev[player.n] != null) return prev;
          return { ...prev, [player.n]: { logs: gameLogs, season } };
        });
      } catch {}
    })
  );
}

// Fetch injury statuses for all teams playing today.
// Returns { [normName]: { status, detail } } for injured/questionable players.
async function fetchInjuryStatuses(teamAbbrs) {
  const map = {};
  await Promise.allSettled(
    teamAbbrs.map(async (abbr) => {
      const id = TEAM_ESPN_IDS[abbr];
      if (!id) return;
      const athletes = await fetchTeamRoster(id);
      for (const a of athletes) {
        if (a.injuryStatus) {
          map[normalizeName(a.name)] = { status: a.injuryStatus, detail: a.injuryDetail };
        }
      }
    })
  );
  return map;
}

// Fetch the full season's player game logs by scraping ESPN game summaries/boxscores.
// The ESPN Core gamelog endpoint is broken for WNBA; the summary endpoint is reliable.
// Returns { [normName]: GameLog[] } sorted newest-first.
async function fetchWNBABoxScoreLogs(lookbackDays = 50) {
  // Build list of date strings over the lookback window
  const today = new Date();
  const dateStrings = [];
  for (let i = lookbackDays; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dateStrings.push(
      `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`
    );
  }

  // Collect completed regular-season game metadata from scoreboard
  const gameInfos = (await Promise.all(
    dateStrings.map(ds =>
      cacheFetch(`${ESPN_BASE}/scoreboard?dates=${ds}&limit=20`, 1_800_000)
        .then(data => (data.events || [])
          .filter(e => e.status?.type?.state === 'post')
          .map(e => {
            const comps = e.competitions?.[0]?.competitors || [];
            const home  = comps.find(c => c.homeAway === 'home');
            const away  = comps.find(c => c.homeAway === 'away');
            return {
              id:       e.id,
              date:     (e.date || ds).slice(0, 10),
              homeAbbr: home?.team?.abbreviation || '',
              awayAbbr: away?.team?.abbreviation || '',
            };
          })
          // Only include regular-season games (on or after season start date)
          .filter(g => g.date >= WNBA_SEASON_START)
        )
        .catch(() => [])
    )
  )).flat();

  if (!gameInfos.length) return {};

  // Fetch each boxscore and build per-player game logs
  const playerLogs = {};
  const displayNames = {};   // norm → display name, for roster derivation

  await Promise.allSettled(
    gameInfos.map(async (game) => {
      try {
        const summary = await cacheFetch(
          `${ESPN_BASE}/summary?event=${game.id}`, 7_200_000
        );
        for (const teamBlock of (summary.boxscore?.players || [])) {
          const teamAbbr = teamBlock.team?.abbreviation || '';
          const isHome   = teamAbbr === game.homeAbbr;
          const opp      = isHome ? game.awayAbbr : game.homeAbbr;
          for (const statBlock of (teamBlock.statistics || [])) {
            const labels = statBlock.labels || [];
            const ix = (lbl) => labels.indexOf(lbl);
            const minI = ix('MIN'), ptsI = ix('PTS'), rebI = ix('REB');
            const astI = ix('AST'), stlI = ix('STL'), blkI = ix('BLK');
            const tptI = ix('3PT'), toI  = ix('TO');
            const fgI  = ix('FG'),  ftI  = ix('FT');
            const orebI = ix('OREB'), drebI = ix('DREB'), pmI = ix('+/-');
            for (const entry of (statBlock.athletes || [])) {
              if (entry.didNotPlay) continue;
              const s    = entry.stats || [];
              const norm = normalizeName(entry.athlete?.displayName || entry.athlete?.shortName || '');
              if (!norm) continue;
              if (!displayNames[norm]) displayNames[norm] = entry.athlete?.displayName || entry.athlete?.shortName || norm;
              const parseMade = (raw) => raw ? (parseInt(raw.split('-')[0]) || 0) : null;
              const parseAtt  = (raw) => raw ? (parseInt(raw.split('-')[1]) || 0) : null;
              const fg3mRaw = tptI >= 0 ? s[tptI] : null;
              const fgRaw   = fgI  >= 0 ? s[fgI]  : null;
              const ftRaw   = ftI  >= 0 ? s[ftI]  : null;
              if (!playerLogs[norm]) playerLogs[norm] = [];
              playerLogs[norm].push({
                date: game.date,
                team: teamAbbr,
                opp,
                home: isHome,
                pts:  ptsI  >= 0 ? (parseFloat(s[ptsI])  || 0) : null,
                reb:  rebI  >= 0 ? (parseFloat(s[rebI])  || 0) : null,
                ast:  astI  >= 0 ? (parseFloat(s[astI])  || 0) : null,
                stl:  stlI  >= 0 ? (parseFloat(s[stlI])  || 0) : null,
                blk:  blkI  >= 0 ? (parseFloat(s[blkI])  || 0) : null,
                to:   toI   >= 0 ? (parseFloat(s[toI])   || 0) : null,
                oreb: orebI >= 0 ? (parseFloat(s[orebI]) || 0) : null,
                dreb: drebI >= 0 ? (parseFloat(s[drebI]) || 0) : null,
                pm:   pmI   >= 0 ? (parseFloat(s[pmI])   || 0) : null,
                fg3m: parseMade(fg3mRaw),
                fg3a: parseAtt(fg3mRaw),
                fgm:  parseMade(fgRaw),
                fga:  parseAtt(fgRaw),
                ftm:  parseMade(ftRaw),
                fta:  parseAtt(ftRaw),
                min:  minI  >= 0 ? (parseFloat(s[minI])  || 0) : null,
              });
            }
          }
        }
      } catch {}
    })
  );

  // Sort each player's log newest-first
  for (const k in playerLogs) {
    playerLogs[k].sort((a, b) => b.date.localeCompare(a.date));
  }
  // Roster is derived from the same logs (newest-first, so gl[0].team is current team).
  return { logs: playerLogs, roster: rosterFromLogs(playerLogs, displayNames) };
}

async function fetchPlayerGameLog(athleteId, season) {
  const url = `${ESPN_CORE}/athletes/${athleteId}/gamelog?season=${season}&seasontype=2`;
  let data;
  try {
    data = await cacheFetch(url, 900_000);
  } catch {
    return [];
  }
  const entries = data.entries || [];
  return entries.map(e => {
    const stats = {};
    (e.statistics || []).forEach(s => { stats[s.name] = s.value; });
    return {
      date: e.gameDate || e.date || "",
      opp: e.opponent?.abbreviation || e.opponent?.displayName || "?",
      home: e.home ?? true,
      pts: stats.points ?? stats.PTS ?? null,
      reb: stats.totalRebounds ?? stats.rebounds ?? stats.REB ?? null,
      ast: stats.assists ?? stats.AST ?? null,
      stl: stats.steals ?? stats.STL ?? null,
      blk: stats.blocks ?? stats.BLK ?? null,
      fg3m: stats.threePointFieldGoalsMade ?? stats.threePointersMade ?? stats.fg3m ?? null,
      min: stats.minutes ?? stats.MIN ?? null,
      result: e.result || "",
    };
  }).filter(g => g.pts != null);
}

// ── PROP STAT CONFIG ─────────────────────────────────────────────────────────
const PROP_TABS = [
  { id: "pts",  label: "PTS",      key: "pts",  combo: false },
  { id: "fg3m", label: "3PM",      key: "fg3m", combo: false },
  { id: "reb",  label: "REB",      key: "reb",  combo: false },
  { id: "ast",  label: "AST",      key: "ast",  combo: false },
  { id: "pra",  label: "PRA",      key: "pra",  combo: true,
    keys: ["pts","reb","ast"], projFn: p => p.pts + p.reb + p.ast },
  { id: "sb",   label: "STL+BLK",  key: "sb",   combo: true,
    keys: ["stl","blk"], projFn: p => p.stl + p.blk },
];

function getComboVal(log, keys) {
  return keys.reduce((sum, k) => sum + (log[k] ?? 0), 0);
}

// ── STYLES ────────────────────────────────────────────────────────────────────
const S = {
  wrap:     { minHeight: "100vh", background: "#0f1923", color: "#e2e8f0", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", position: "relative" },
  grid:     { position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, backgroundImage: "linear-gradient(rgba(125,211,252,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(125,211,252,0.025) 1px, transparent 1px)", backgroundSize: "48px 48px" },
  glow:     { position: "fixed", top: 0, left: "50%", transform: "translateX(-50%)", width: "70%", height: 280, pointerEvents: "none", zIndex: 0, background: "radial-gradient(ellipse at 50% 0%, rgba(125,211,252,0.06) 0%, transparent 70%)" },
  content:  { position: "relative", zIndex: 1 },
  header:   { padding: "10px 16px", background: "rgba(26,37,53,0.92)", backdropFilter: "blur(12px)", borderBottom: "1px solid rgba(74,86,110,0.6)", position: "sticky", top: 0, zIndex: 100 },
  hRow:     { display: "flex", justifyContent: "space-between", alignItems: "center", maxWidth: 1400, margin: "0 auto" },
  title:    { fontSize: 18, fontWeight: "bold", color: "#7dd3fc", display: "flex", alignItems: "center", gap: 8 },
  badge:    (color = "#f59e0b") => ({ fontSize: 9, padding: "2px 7px", background: color === "live" ? "rgba(74,222,128,0.15)" : `linear-gradient(135deg,${color},${color}cc)`, color: color === "live" ? "#4ade80" : "#fff", borderRadius: 4, fontWeight: 700, border: color === "live" ? "1px solid rgba(74,222,128,0.3)" : "none", letterSpacing: "0.04em" }),
  subtitle: { fontSize: 10, color: "#7a8fa8", fontFamily: "monospace", marginTop: 2 },
  btn:      { display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", background: "rgba(125,211,252,0.08)", border: "1px solid rgba(125,211,252,0.25)", borderRadius: 6, color: "#7dd3fc", cursor: "pointer", fontSize: 11, fontWeight: 500 },
  btnActive:{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", background: "rgba(125,211,252,0.18)", border: "1px solid rgba(125,211,252,0.5)", borderRadius: 6, color: "#7dd3fc", cursor: "pointer", fontSize: 11, fontWeight: 700 },
  main:     { padding: "12px 16px", maxWidth: 1400, margin: "0 auto" },
  tabNav:   { display: "flex", gap: 4, marginBottom: 12, overflowX: "auto", paddingBottom: 4 },
  tabBtn:   (active) => ({ padding: "8px 16px", background: active ? "rgba(125,211,252,0.14)" : "rgba(26,37,53,0.6)", border: `1px solid ${active ? "rgba(125,211,252,0.35)" : "#4a566e"}`, borderRadius: 6, color: active ? "#7dd3fc" : "#7a8fa8", cursor: "pointer", fontSize: 11, fontWeight: 500, whiteSpace: "nowrap" }),
  card:     { background: "rgba(26,37,53,0.85)", border: "1px solid #4a566e", borderRadius: 10, overflow: "hidden", marginBottom: 12, boxShadow: "0 4px 24px rgba(0,0,0,0.4), 0 1px 0 rgba(125,211,252,0.04) inset" },
  cardHead: { padding: "10px 14px", background: "rgba(17,24,39,0.8)", borderBottom: "1px solid #4a566e", display: "flex", justifyContent: "space-between", alignItems: "center" },
  cardTitle:{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" },
  propTabs: { display: "flex", gap: 3, padding: "8px 12px", background: "rgba(17,24,39,0.6)", borderBottom: "1px solid #4a566e", overflowX: "auto" },
  propTab:  (active) => ({ padding: "5px 14px", background: active ? "rgba(125,211,252,0.15)" : "transparent", border: `1px solid ${active ? "rgba(125,211,252,0.4)" : "#4a566e"}`, borderRadius: 5, color: active ? "#7dd3fc" : "#94a3b8", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }),
  searchWrap:{ padding: "8px 12px", borderBottom: "1px solid #4a566e", display: "flex", gap: 8, alignItems: "center", background: "rgba(17,24,39,0.5)", flexWrap: "wrap" },
  searchIn: { flex: 1, minWidth: 160, background: "#0f1923", border: "1px solid #4a566e", borderRadius: 5, padding: "5px 10px", color: "#e2e8f0", fontSize: 12, outline: "none" },
  tbl:      { width: "100%", overflowX: "auto" },
  th:       { padding: "8px 10px", fontSize: 9, color: "#64748b", fontWeight: 600, textTransform: "uppercase", textAlign: "center", whiteSpace: "nowrap", background: "rgba(17,24,39,0.7)", borderBottom: "1px solid #4a566e", cursor: "pointer", userSelect: "none" },
  thLeft:   { padding: "8px 12px", fontSize: 9, color: "#64748b", fontWeight: 600, textTransform: "uppercase", textAlign: "left", background: "rgba(17,24,39,0.7)", borderBottom: "1px solid #4a566e", cursor: "pointer", userSelect: "none", minWidth: 170 },
  td:       { padding: "9px 10px", fontSize: 12, textAlign: "center", borderBottom: "1px solid rgba(74,86,110,0.4)", fontFamily: "monospace" },
  tdLeft:   { padding: "9px 12px", fontSize: 12, textAlign: "left", borderBottom: "1px solid rgba(74,86,110,0.4)" },
  tag:      (bg, color) => ({ display: "inline-block", fontSize: 9, padding: "1px 5px", borderRadius: 3, background: bg, color, margin: "1px" }),
};

// ── SORT BUTTON ───────────────────────────────────────────────────────────────
function SortBtn({ col, sort, onSort, children }) {
  const active = sort.col === col;
  return (
    <button
      onClick={() => onSort(col)}
      style={{ background: "none", border: "none", color: active ? "#7dd3fc" : "inherit", cursor: "pointer", fontSize: 9, fontWeight: 600, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 2, padding: 0 }}
    >
      {children}
      <span style={{ opacity: active ? 1 : 0.4 }}>{active ? (sort.dir === "desc" ? " ▼" : " ▲") : " ▼"}</span>
    </button>
  );
}

// ── TODAY'S SLATE ─────────────────────────────────────────────────────────────
function TodaySlate({ games, loading, selectedGame, onSelectGame }) {
  if (loading) return (
    <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
      <div style={{ fontSize: 9, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>Today's Slate</div>
      <div style={{ fontSize: 11, color: "#4a566e", fontFamily: "monospace" }}>Loading…</div>
    </div>
  );

  if (!games.length) return (
    <div style={{ background: "rgba(26,37,53,0.5)", border: "1px solid #4a566e", borderRadius: 8, padding: "10px 14px", marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 9, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Today's Slate</span>
      <span style={{ fontSize: 11, color: "#4a566e", fontFamily: "monospace" }}>No WNBA games today</span>
    </div>
  );

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 9, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Today's Slate · {games.length} {games.length === 1 ? "Game" : "Games"}
        </span>
        {selectedGame && (
          <span style={{ fontSize: 9, color: "#7dd3fc", fontFamily: "monospace" }}>
            · filtering {selectedGame.awayAbbr} @ {selectedGame.homeAbbr} —{" "}
            <span
              style={{ textDecoration: "underline", cursor: "pointer", color: "#7a8fa8" }}
              onClick={() => onSelectGame(null)}
            >clear</span>
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
        {games.map(g => <SlateGameCard key={g.id} game={g} selectedGame={selectedGame} onSelectGame={onSelectGame} />)}
      </div>
    </div>
  );
}

function SlateGameCard({ game, selectedGame, onSelectGame }) {
  const homeTeam = game.home?.team;
  const awayTeam = game.away?.team;
  const homeAbbr = homeTeam?.abbreviation || game.home?.team?.abbreviation || "?";
  const awayAbbr = awayTeam?.abbreviation || game.away?.team?.abbreviation || "?";
  const homeScore = game.home?.score;
  const awayScore = game.away?.score;
  const isLive = game.statusState === "in";
  const isFinal = game.statusState === "post";
  const homeMeta = TEAM_META[homeAbbr] || {};
  const awayMeta = TEAM_META[awayAbbr] || {};
  const isSelected = selectedGame?.id === game.id;

  const timeLabel = isLive ? "● LIVE"
    : isFinal ? "FINAL"
    : (() => { try { return new Date(game.date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" }); } catch { return game.status; } })();

  function handleClick() {
    onSelectGame?.(isSelected ? null : { id: game.id, homeAbbr, awayAbbr });
  }

  return (
    <div
      onClick={handleClick}
      style={{
        background: isSelected ? "rgba(125,211,252,0.1)" : "rgba(17,24,39,0.8)",
        border: `1px solid ${isSelected ? "rgba(125,211,252,0.55)" : isLive ? "rgba(74,222,128,0.3)" : "#4a566e"}`,
        borderRadius: 8, overflow: "hidden", minWidth: 200, flexShrink: 0, cursor: "pointer",
        boxShadow: isSelected ? "0 0 18px rgba(125,211,252,0.14)" : isLive ? "0 0 16px rgba(74,222,128,0.08)" : "0 2px 8px rgba(0,0,0,0.3)",
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
    >
      <div style={{ padding: "5px 10px", borderBottom: "1px solid #4a566e", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 10, color: isLive ? "#4ade80" : isFinal ? "#7a8fa8" : "#7dd3fc", fontFamily: "monospace", fontWeight: 700 }}>
          {timeLabel}
        </span>
        {isSelected && <span style={{ fontSize: 8, color: "#7dd3fc", fontWeight: 700, letterSpacing: "0.06em" }}>FILTERED</span>}
      </div>
      <div style={{ padding: "8px 10px" }}>
        {[
          { abbr: awayAbbr, score: awayScore, meta: awayMeta, prefix: "@" },
          { abbr: homeAbbr, score: homeScore, meta: homeMeta, prefix: "" },
        ].map((side, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "3px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 3, height: 18, borderRadius: 2, background: side.meta.color || "#4a566e", display: "inline-block", flexShrink: 0 }} />
              <div>
                <span style={{ fontSize: 12, fontWeight: 700, color: side.meta.color || "#e2e8f0" }}>{side.abbr}</span>
                <span style={{ fontSize: 9, color: "#7a8fa8", marginLeft: 4 }}>{i === 0 ? "AWAY" : "HOME"}</span>
              </div>
            </div>
            {(isLive || isFinal) && side.score != null && (
              <span style={{ fontSize: 15, fontWeight: 700, fontFamily: "monospace", color: "#e2e8f0" }}>{side.score}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── GAME LOG ROW ──────────────────────────────────────────────────────────────
function GameLogInline({ logs, propTab, line, season, model, advanced, scoring }) {
  const cfg = PROP_TABS.find(t => t.id === propTab);
  const getVal = (g) => cfg.combo ? getComboVal(g, cfg.keys) : (g[cfg.key] ?? 0);

  return (
    <tr>
      <td colSpan={18} style={{ padding: 0, background: "#0b1520", borderBottom: "1px solid #4a566e" }}>
        <div style={{ padding: "10px 16px 14px" }}>

          {/* Model summary panel */}
          {model && (
            <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
              {/* Model stats */}
              <div style={{ background: "rgba(125,211,252,0.05)", border: "1px solid rgba(125,211,252,0.15)", borderRadius: 7, padding: "8px 14px", minWidth: 220 }}>
                <div style={{ fontSize: 8, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Model Breakdown</div>
                {/* Projection chain */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 8, color: "#7a8fa8", marginBottom: 2 }}>Season proj</div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "monospace", color: "#64748b" }}>{fmt1(model.projLine)}</div>
                  </div>
                  {model.minsMult != null && Math.abs(model.minsMult - 1) > 0.03 && <>
                    <span style={{ color: "#4a566e", fontSize: 11 }}>→</span>
                    <div style={{ textAlign: "center" }} title={`Prior scaled for role: ${fmt1(model.recentMin)} recent min vs projected`}>
                      <div style={{ fontSize: 8, color: model.minsMult > 1 ? "#4ade80" : "#f87171", marginBottom: 2 }}>Min-adj ×{model.minsMult.toFixed(2)}</div>
                      <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "monospace", color: "#94a3b8" }}>{fmt1(model.priorAnchor)}</div>
                    </div>
                  </>}
                  <span style={{ color: "#4a566e", fontSize: 11 }}>→</span>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 8, color: "#7a8fa8", marginBottom: 2 }}>Bayes blend</div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "monospace", color: "#94a3b8" }}>{fmt1(model.baseProj)}</div>
                  </div>
                  {model.factors.length > 0 && <>
                    <span style={{ color: "#4a566e", fontSize: 11 }}>→</span>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 8, color: "#7dd3fc", marginBottom: 2 }}>Adjusted</div>
                      <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "monospace", color: "#7dd3fc" }}>{fmt1(model.modelProj)}</div>
                    </div>
                  </>}
                </div>
                {/* Adjustment factors */}
                {model.factors.length > 0 && (
                  <div style={{ borderTop: "1px solid rgba(74,86,110,0.4)", paddingTop: 6, marginBottom: 6 }}>
                    <div style={{ fontSize: 8, color: "#64748b", fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Adjustments</div>
                    {model.factors.map((f, i) => {
                      const up = f.mult > 1.005;
                      const dn = f.mult < 0.995;
                      const pctStr = (up ? "+" : "") + ((f.mult - 1) * 100).toFixed(1) + "%";
                      return (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0" }}>
                          <span style={{ fontSize: 10, color: "#94a3b8" }}>{f.label}</span>
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            {f.detail && <span style={{ fontSize: 9, color: "#4a566e", fontFamily: "monospace" }}>{f.detail}</span>}
                            <span style={{ fontSize: 10, fontWeight: 700, fontFamily: "monospace", color: up ? "#4ade80" : dn ? "#f87171" : "#7a8fa8" }}>{pctStr}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Meta stats */}
                <div style={{ display: "flex", gap: 12, fontSize: 9, color: "#7a8fa8", borderTop: "1px solid rgba(74,86,110,0.4)", paddingTop: 5 }}>
                  <span>σ ±{fmt1(model.sigma)}</span>
                  <span>{model.gp}g · {Math.round(model.dataWeight * 100)}% data</span>
                  {model.usingSeasonAvg && <span style={{ color: "#fbbf24" }}>2025 avg</span>}
                  {model.factors.length === 0 && !model.usingSeasonAvg && <span style={{ color: "#4a566e" }}>no matchup data</span>}
                </div>
                {/* Advanced stats from NBA API */}
                {advanced && (
                  <div style={{ display: "flex", gap: 10, marginTop: 8, borderTop: "1px solid rgba(74,86,110,0.4)", paddingTop: 7, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 8, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", width: "100%", marginBottom: 2 }}>Advanced Stats</div>
                    {[
                      { label: "USG%", val: advanced.usgPct, color: "#7dd3fc" },
                      { label: "TS%",  val: advanced.tsPct,  color: "#4ade80" },
                      { label: "eFG%", val: advanced.efgPct, color: "#a78bfa" },
                      { label: "AST%", val: advanced.astPct, color: "#94a3b8" },
                      { label: "OREB%",val: advanced.orebPct,color: "#94a3b8" },
                      { label: "DREB%",val: advanced.drebPct,color: "#94a3b8" },
                    ].map(({ label, val, color }) => val != null && (
                      <div key={label} style={{ textAlign: "center", minWidth: 44 }}>
                        <div style={{ fontSize: 8, color: "#64748b", marginBottom: 2 }}>{label}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color }}>{(val * 100).toFixed(1)}%</div>
                      </div>
                    ))}
                  </div>
                )}
                {/* Scoring profile — shot mix + assisted share (stats.wnba.com) */}
                {scoring && (scoring.pctPts3 != null || scoring.pctPtsPaint != null || scoring.pctUast != null) && (
                  <div style={{ display: "flex", gap: 10, marginTop: 8, borderTop: "1px solid rgba(74,86,110,0.4)", paddingTop: 7, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 8, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", width: "100%", marginBottom: 2 }}>Scoring Profile</div>
                    {[
                      { label: "% pts 3PT",  val: scoring.pctPts3,     color: "#f472b6" },
                      { label: "% pts paint",val: scoring.pctPtsPaint, color: "#fbbf24" },
                      { label: "% pts FT",   val: scoring.pctPtsFt,    color: "#94a3b8" },
                      { label: "Unassisted", val: scoring.pctUast,     color: "#7dd3fc" },
                    ].map(({ label, val, color }) => val != null && (
                      <div key={label} style={{ textAlign: "center", minWidth: 52 }}>
                        <div style={{ fontSize: 8, color: "#64748b", marginBottom: 2 }}>{label}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color }}>{(val * 100).toFixed(0)}%</div>
                      </div>
                    ))}
                  </div>
                )}
                {/* Gravity — AWS Inside the Game defensive-attention splits */}
                {model.gravity && model.gravity.gravity != null && (
                  <div style={{ display: "flex", gap: 10, marginTop: 8, borderTop: "1px solid rgba(74,86,110,0.4)", paddingTop: 7, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 8, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", width: "100%", marginBottom: 2 }}>
                      Gravity · AWS Inside the Game <span style={{ color: "#4a566e", textTransform: "none", letterSpacing: 0 }}>(0 = league avg)</span>
                    </div>
                    {[
                      { label: "Overall",       val: model.gravity.gravity },
                      { label: "On-ball perim", val: model.gravity.onBallPerim },
                      { label: "Off-ball perim",val: model.gravity.offBallPerim },
                      { label: "On-ball int",   val: model.gravity.onBallInt },
                      { label: "Off-ball int",  val: model.gravity.offBallInt },
                    ].map(({ label, val }) => val != null && (
                      <div key={label} style={{ textAlign: "center", minWidth: 52 }}>
                        <div style={{ fontSize: 8, color: "#64748b", marginBottom: 2 }}>{label}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: val >= 8 ? "#4ade80" : val >= 0 ? "#7dd3fc" : "#f87171" }}>
                          {val > 0 ? "+" : ""}{val.toFixed(1)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Probability ladder */}
              <div style={{ flex: 1, minWidth: 260 }}>
                <div style={{ fontSize: 8, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
                  Probability Ladder · P(over line)
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {model.ladder.map(({ line: l, prob, fairOdds }) => {
                    const isBest = l === model.bestLine;
                    const pct = prob != null ? Math.round(prob * 100) : null;
                    const barColor = pctColor(pct);
                    return (
                      <div key={l} style={{
                        background: isBest ? "rgba(125,211,252,0.12)" : "rgba(26,37,53,0.6)",
                        border: `1px solid ${isBest ? "rgba(125,211,252,0.4)" : "#4a566e"}`,
                        borderRadius: 5, padding: "5px 8px", minWidth: 68, textAlign: "center",
                      }}>
                        <div style={{ fontSize: 10, fontWeight: 700, fontFamily: "monospace", color: isBest ? "#7dd3fc" : "#94a3b8" }}>{l}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: barColor }}>{pct != null ? pct + "%" : "--"}</div>
                        <div style={{ fontSize: 9, color: oddsColor(fairOdds), fontFamily: "monospace" }}>{fmtOdds(fairOdds)}</div>
                        {isBest && <div style={{ fontSize: 7, color: "#7dd3fc", fontWeight: 700, marginTop: 1 }}>BEST</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <div style={{ fontSize: 9, color: "#64748b", fontWeight: 600, textTransform: "uppercase", marginBottom: 6 }}>
            Last {logs.length} Games · {cfg.label} proj: {fmt1(line)}
            {season && season < ACTIVE_SEASON && (
              <span style={{ marginLeft: 8, color: "#fbbf24" }}>· {season} data</span>
            )}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "monospace" }}>
              <thead>
                <tr style={{ color: "#64748b", fontSize: 9, textTransform: "uppercase" }}>
                  {["Date","Opp","MIN","PTS","3PM","3PA","REB","AST","STL","BLK","TO",cfg.label].map((h, i) => (
                    <th key={i} style={{ padding: "3px 8px", textAlign: i < 2 ? "left" : "center", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.slice(0, 15).map((g, i) => {
                  const val = getVal(g);
                  const hit = val >= line;
                  const C = { padding: "4px 8px", textAlign: "center" };
                  return (
                    <tr key={i} style={{ borderTop: "1px solid rgba(26,37,53,0.8)" }}>
                      <td style={{ padding: "4px 8px", color: "#94a3b8", textAlign: "left" }}>{g.date ? g.date.slice(0,10) : "--"}</td>
                      <td style={{ padding: "4px 8px", color: "#e2e8f0", textAlign: "left" }}>{g.home ? "" : "@"}{g.opp}</td>
                      <td style={{ ...C, color: "#7a8fa8" }}>{fmt1(g.min)}</td>
                      <td style={C}>{fmt1(g.pts)}</td>
                      <td style={C}>{fmt1(g.fg3m)}</td>
                      <td style={{ ...C, color: "#94a3b8" }}>{g.fg3a != null ? fmt1(g.fg3a) : "--"}</td>
                      <td style={C}>{fmt1(g.reb)}</td>
                      <td style={C}>{fmt1(g.ast)}</td>
                      <td style={C}>{fmt1(g.stl)}</td>
                      <td style={C}>{fmt1(g.blk)}</td>
                      <td style={{ ...C, color: "#f87171" }}>{fmt1(g.to)}</td>
                      <td style={{ ...C, color: hit ? "#4ade80" : "#f87171", fontWeight: 700 }}>
                        {fmt1(val)}
                        <span style={{ marginLeft: 4, fontSize: 10 }}>{hit ? "✓" : "✗"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </td>
    </tr>
  );
}

// ── PLAYER PROPS ROW ──────────────────────────────────────────────────────────
function PlayerPropsRow({ player, propTab, sort, espnTeams, expanded, onToggle, logCache, setLogCache, isToday, matchup, teamStats, seasonAvg, injuryMap, advancedStats, modelCtx }) {
  const cfg = PROP_TABS.find(t => t.id === propTab);
  const projLine = cfg.combo ? cfg.projFn(player) : player[cfg.key];
  const teamColor = TEAM_META[player.t]?.color || "#7dd3fc";
  const isOut = (() => { const inj = injuryMap?.[normalizeName(player.n)]; return inj?.status?.toLowerCase().includes("out") ?? false; })();

  const [loading, setLoading] = useState(false);

  const entry = logCache[player.n] || null;
  const logs = entry?.logs || null;
  const logSeason = entry?.season || ACTIVE_SEASON;

  const l5  = logs ? logs.slice(0, 5)  : null;
  const l10 = logs ? logs.slice(0, 10) : null;
  const l20 = logs ? logs.slice(0, 20) : null;

  const getVal = (g) => cfg.combo ? getComboVal(g, cfg.keys) : (g[cfg.key] ?? 0);
  const comboAvg = (arr) => arr ? arr.reduce((s, g) => s + getVal(g), 0) / arr.length : null;

  const dispL5  = cfg.combo ? comboAvg(l5)  : avg(l5,  cfg.key);
  const dispL10 = cfg.combo ? comboAvg(l10) : avg(l10, cfg.key);

  const comboHitRate = (arr) => {
    if (!arr || arr.length === 0) return null;
    return Math.round(arr.filter(g => getVal(g) >= projLine).length / arr.length * 100);
  };
  const dispL5hr  = cfg.combo ? comboHitRate(l5)  : calcHitRate(l5,  cfg.key, projLine);
  const dispL10hr = cfg.combo ? comboHitRate(l10) : calcHitRate(l10, cfg.key, projLine);
  const dispL20hr = cfg.combo ? comboHitRate(l20) : calcHitRate(l20, cfg.key, projLine);

  const edge = edgeLabel(projLine, dispL10);

  // Predictive model — Bayesian blend + home/away + BvP + opp def + pace + L3 momentum
  const model = useMemo(
    () => buildWNBAModel(player, logs, cfg, matchup, teamStats, seasonAvg, modelCtx),
    [player, logs, cfg, matchup, teamStats, seasonAvg, modelCtx]
  );

  async function loadLogs() {
    if (entry !== null || loading) return;
    setLoading(true);
    try {
      const team = espnTeams.find(t => t.abbrev === player.t || t.abbrev === player.t.toUpperCase());
      if (team) {
        const roster = await fetchTeamRoster(team.id);
        const norm = normalizeName(player.n);
        const match = roster.find(a =>
          normalizeName(a.name) === norm ||
          normalizeName(a.name).split(" ").slice(-1)[0] === norm.split(" ").slice(-1)[0]
        );
        if (match) {
          // Try current season first; fall back to prior season if empty (early in season)
          let gameLogs = await fetchPlayerGameLog(match.id, ACTIVE_SEASON);
          let season = ACTIVE_SEASON;
          if (gameLogs.length === 0) {
            gameLogs = await fetchPlayerGameLog(match.id, ACTIVE_SEASON - 1);
            season = ACTIVE_SEASON - 1;
          }
          setLogCache(prev => ({ ...prev, [player.n]: { logs: gameLogs, season } }));
          setLoading(false);
          return;
        }
      }
      setLogCache(prev => ({ ...prev, [player.n]: { logs: [], season: ACTIVE_SEASON } }));
    } catch {
      setLogCache(prev => ({ ...prev, [player.n]: { logs: [], season: ACTIVE_SEASON } }));
    }
    setLoading(false);
  }

  function handleToggle() {
    onToggle(player.n);
    if (!entry) loadLogs();
  }

  const rowBg = expanded
    ? "rgba(125,211,252,0.06)"
    : isOut
    ? "rgba(248,113,113,0.04)"
    : isToday
    ? "rgba(125,211,252,0.025)"
    : "transparent";

  return (
    <>
      <tr
        onClick={handleToggle}
        style={{ cursor: "pointer", background: rowBg, transition: "background 0.15s" }}
        onMouseEnter={e => { if (!expanded) e.currentTarget.style.background = isToday ? "rgba(125,211,252,0.05)" : "rgba(125,211,252,0.03)"; }}
        onMouseLeave={e => { if (!expanded) e.currentTarget.style.background = rowBg; }}
      >
        {/* Player */}
        <td style={S.tdLeft}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 3, height: 30, borderRadius: 2, background: teamColor, flexShrink: 0, display: "inline-block" }} />
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: "#e2e8f0" }}>{player.n}</span>
                {isToday && (
                  <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "rgba(74,222,128,0.15)", color: "#4ade80", border: "1px solid rgba(74,222,128,0.25)", letterSpacing: "0.04em" }}>
                    TODAY
                  </span>
                )}
                {(() => {
                  const inj = injuryMap?.[normalizeName(player.n)];
                  if (!inj) return null;
                  const s = inj.status?.toLowerCase() || "";
                  const color = s.includes("out") ? "#f87171" : s.includes("doubtful") ? "#fb923c" : "#fbbf24";
                  const bg   = s.includes("out") ? "rgba(248,113,113,0.13)" : s.includes("doubtful") ? "rgba(251,146,60,0.13)" : "rgba(251,191,36,0.13)";
                  const label = s.includes("out") ? "OUT" : s.includes("doubtful") ? "DBTF" : s.includes("questionable") ? "QUES" : s.includes("day") ? "DTD" : inj.status?.slice(0,4).toUpperCase() || "INJ";
                  return (
                    <span title={inj.detail || inj.status} style={{ fontSize: 7, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: bg, color, border: `1px solid ${color}44`, letterSpacing: "0.04em" }}>
                      {label}
                    </span>
                  );
                })()}
              </div>
              <div style={{ fontSize: 10, color: "#7a8fa8" }}>
                <span style={{ fontWeight: 600, color: teamColor }}>{player.t}</span>
                {" · "}{player.pos}
              </div>
            </div>
          </div>
        </td>
        {/* Model Proj */}
        <td style={{ ...S.td, color: "#7dd3fc", fontWeight: 700 }}>
          {isOut ? <span style={{ color: "#4a566e" }}>--</span> : loading ? <span style={{ color: "#64748b", fontSize: 10 }}>…</span> : (
            <span title={model.usingSeasonAvg ? `${model.gp}g 2025 avg` : `${model.gp}g logged`}>
              {fmt1(model.modelProj)}
              {model.usingSeasonAvg && <span style={{ fontSize: 7, color: "#fbbf24", marginLeft: 2 }}>★</span>}
            </span>
          )}
        </td>
        {/* Best Line */}
        <td style={{ ...S.td, color: "#e2e8f0", fontFamily: "monospace" }}>
          {isOut ? <span style={{ color: "#4a566e" }}>--</span> : loading ? "…" : model.bestLine != null ? (
            <span style={{ fontSize: 11, fontWeight: 600 }}>{model.bestLine}</span>
          ) : "—"}
        </td>
        {/* Win% — P(the side the model is on), with the side marked */}
        <td style={S.td}>
          {isOut ? <span style={{ color: "#4a566e" }}>--</span> : loading ? "…" : model.winProb != null ? (() => {
            const pct  = Math.round(model.winProb * 100);
            const side = model.bestSide;
            const off  = !model.bestInWindow;   // projection sits off the end of the ladder
            return (
              <span
                title={off
                  ? `Off-ladder: no line in the ${cfg.label} ladder lands near this projection, so ${pct}% is a function of where the ladder stops, not a bettable edge.`
                  : `Model gives the ${side === 'over' ? 'OVER' : 'UNDER'}${model.bestLine != null ? ` ${model.bestLine}` : ""} a ${pct}% chance to hit (P(over) = ${Math.round(model.bestProb * 100)}%).`}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", opacity: off ? 0.45 : 1 }}>
                <span style={{ color: off ? "#7a8fa8" : winProbColor(pct), fontWeight: 700 }}>{pct}%</span>
                <span style={{
                  fontSize: 8, fontWeight: 800, lineHeight: 1, padding: "2px 4px", borderRadius: 3,
                  color: off ? "#7a8fa8" : sideColor(side),
                  background: off ? "rgba(120,143,168,0.10)" : side === 'over' ? "rgba(74,222,128,0.12)" : "rgba(248,113,113,0.12)",
                  border: `1px solid ${off ? "rgba(120,143,168,0.2)" : side === 'over' ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)"}`,
                }}>{side === 'over' ? 'O' : 'U'}</span>
              </span>
            );
          })() : "—"}
        </td>
        {/* Fair odds */}
        <td style={S.td}>
          {isOut ? <span style={{ color: "#4a566e" }}>--</span> : loading ? "…" : model.fairOdds != null ? (
            <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "monospace", color: oddsColor(model.fairOdds) }}>
              {fmtOdds(model.fairOdds)}
            </span>
          ) : "—"}
        </td>
        {/* Confidence */}
        <td style={S.td}>
          {isOut ? <span style={{ color: "#4a566e" }}>--</span> : loading ? "…" : (() => {
            const cs = confStyle(model.confidence);
            const side = sideOf(model.bestProb);
            return (
              <span
                title={side
                  ? `${model.confidence.toUpperCase()} conviction on the ${side.toUpperCase()}${model.bestLine != null ? ` ${model.bestLine}` : ""} — confidence measures distance from a coin flip, not how likely the over is.`
                  : "No line priced"}
                style={{ fontSize: 8, fontWeight: 700, padding: "2px 5px", borderRadius: 3, background: cs.bg, color: cs.color, border: `1px solid ${cs.border}`, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
                {model.confidence}
                {side && <span style={{ marginLeft: 3, color: sideColor(side), fontSize: 9 }}>
                  {sideArrow(model.bestProb)}{side === 'over' ? 'O' : 'U'}
                </span>}
              </span>
            );
          })()}
        </td>
        {/* L5 Avg */}
        <td style={{ ...S.td, color: "#e2e8f0" }}>
          {isOut ? <span style={{ color: "#4a566e" }}>--</span> : loading ? <span style={{ color: "#64748b", fontSize: 10 }}>…</span> : fmt1(dispL5)}
        </td>
        {/* L10 Avg */}
        <td style={{ ...S.td, color: "#e2e8f0" }}>
          {isOut ? <span style={{ color: "#4a566e" }}>--</span> : loading ? <span style={{ color: "#64748b", fontSize: 10 }}>…</span> : fmt1(dispL10)}
        </td>
        {/* L5 Hit% */}
        <td style={S.td}>
          {isOut ? <span style={{ color: "#4a566e" }}>--</span> : loading ? "…" : <span style={{ color: pctColor(dispL5hr), fontWeight: 600 }}>{fmtPct(dispL5hr)}</span>}
        </td>
        {/* L10 Hit% */}
        <td style={S.td}>
          {isOut ? <span style={{ color: "#4a566e" }}>--</span> : loading ? "…" : <span style={{ color: pctColor(dispL10hr), fontWeight: 600 }}>{fmtPct(dispL10hr)}</span>}
        </td>
        {/* L20 Hit% */}
        <td style={S.td}>
          {isOut ? <span style={{ color: "#4a566e" }}>--</span> : loading ? "…" : <span style={{ color: pctColor(dispL20hr), fontWeight: 600 }}>{fmtPct(dispL20hr)}</span>}
        </td>
        {/* Season averages from real game logs (fall back to projections) */}
        {['pts','reb','ast','fg3m','stl','blk'].map(k => {
          if (isOut) return <td key={k} style={{ ...S.td, color: "#4a566e", fontSize: 11 }}>--</td>;
          const v = logs && logs.length > 0 ? avg(logs, k) : null;
          return (
            <td key={k} style={{ ...S.td, color: v != null ? "#e2e8f0" : "#4a566e", fontSize: 11 }}>
              {v != null ? fmt1(v) : fmt1(player[k])}
            </td>
          );
        })}
        <td style={{ ...S.td, fontSize: 14, color: "#4a566e" }}>{expanded ? "▲" : "▶"}</td>
      </tr>
      {expanded && logs && logs.length > 0 && (
        <GameLogInline logs={logs} propTab={propTab} line={projLine} season={logSeason} model={model} advanced={advancedStats?.[normalizeName(player.n)] || null} scoring={modelCtx?.playerScoring?.[normalizeName(player.n)] || null} />
      )}
      {expanded && logs && logs.length === 0 && (
        <tr>
          <td colSpan={18} style={{ padding: "10px 16px", background: "#0b1520", color: "#64748b", fontSize: 11, fontFamily: "monospace", borderBottom: "1px solid #4a566e" }}>
            No game log data available via ESPN · Projections only
          </td>
        </tr>
      )}
      {expanded && !entry && loading && (
        <tr>
          <td colSpan={18} style={{ padding: "10px 16px", background: "#0b1520", color: "#7a8fa8", fontSize: 11, borderBottom: "1px solid #4a566e" }}>
            Loading game log…
          </td>
        </tr>
      )}
    </>
  );
}

// ── PROPS SCANNER TAB ─────────────────────────────────────────────────────────
function PropsScanner({ players = PROJ_2026, espnTeams, logCache, setLogCache, todayTeams, todayMatchups, teamStats, playerSeasonAvgs, selectedGame, injuryMap, advancedStats, modelCtx }) {
  const [propTab, setPropTab]       = useState("pts");
  // Win% desc is the working default: it's the one ranking that puts the plays the
  // model believes in most at the top, whichever side they're on.
  const [sort, setSort]             = useState({ col: "prob", dir: "desc" });
  const [search, setSearch]         = useState("");
  const [teamFilter, setTeamFilter] = useState("ALL");
  const [todayOnly, setTodayOnly]   = useState(true);
  const [expanded, setExpanded]     = useState(null);

  const teams = useMemo(() => ["ALL", ...Array.from(new Set(players.map(p => p.t))).sort()], [players]);

  function handleSort(col) {
    setSort(s => ({ col, dir: s.col === col && s.dir === "desc" ? "asc" : "desc" }));
  }

  const cfg = PROP_TABS.find(t => t.id === propTab);

  // Compute model + hit rates for ALL players so every column is sortable.
  const allStats = useMemo(() => {
    const getVal = (g) => cfg.combo ? getComboVal(g, cfg.keys) : (g[cfg.key] ?? 0);
    const m = {};
    for (const p of players) {
      const entry     = logCache[p.n] || null;
      const logs      = entry?.logs || null;
      const matchup   = todayMatchups[p.t] || null;
      const sa        = playerSeasonAvgs[normalizeName(p.n)] || null;
      const model     = buildWNBAModel(p, logs, cfg, matchup, teamStats, sa, modelCtx);
      const projLine  = cfg.combo ? cfg.projFn(p) : p[cfg.key];
      const l5        = logs?.slice(0, 5) ?? null;
      const l10       = logs?.slice(0, 10) ?? null;
      const l20       = logs?.slice(0, 20) ?? null;
      const cAvg      = (arr) => arr ? arr.reduce((s, g) => s + getVal(g), 0) / arr.length : null;
      const cHit      = (arr) => arr?.length > 0 ? Math.round(arr.filter(g => getVal(g) >= projLine).length / arr.length * 100) : null;
      m[p.n] = {
        model,
        l5avg:  cfg.combo ? cAvg(l5)  : avg(l5,  cfg.key),
        l10avg: cfg.combo ? cAvg(l10) : avg(l10, cfg.key),
        l5hr:   cfg.combo ? cHit(l5)  : calcHitRate(l5,  cfg.key, projLine),
        l10hr:  cfg.combo ? cHit(l10) : calcHitRate(l10, cfg.key, projLine),
        l20hr:  cfg.combo ? cHit(l20) : calcHitRate(l20, cfg.key, projLine),
      };
    }
    return m;
  }, [players, logCache, cfg, todayMatchups, teamStats, playerSeasonAvgs, modelCtx]);

  const sorted = useMemo(() => {
    const filtered = players.filter(p => {
      const nameOk = !search || normalizeName(p.n).includes(normalizeName(search));
      if (selectedGame) {
        const gameTeams = new Set([selectedGame.homeAbbr, selectedGame.awayAbbr]);
        return nameOk && gameTeams.has(p.t);
      }
      const teamOk = teamFilter === "ALL" || p.t === teamFilter;
      // When there's no slate, todayTeams is empty — don't let the "today only"
      // default filter everyone out (the toggle button is hidden in that case).
      const todayOk = !todayOnly || todayTeams.size === 0 || todayTeams.has(p.t);
      return nameOk && teamOk && todayOk;
    });
    const isOut = (p) => {
      const inj = injuryMap[normalizeName(p.n)];
      return inj?.status?.toLowerCase().includes("out") ?? false;
    };
    return [...filtered].sort((a, b) => {
      // OUT players always sink to bottom regardless of sort
      const aOut = isOut(a), bOut = isOut(b);
      if (aOut !== bOut) return aOut ? 1 : -1;
      const sa = allStats[a.n], sb = allStats[b.n];
      // Win% desc would otherwise be led by off-ladder rows — a 3.1-pt projection is
      // 96% to go under a 7.5 floor, which outranks every real edge on the board. Sink
      // them the same way OUT players sink, so the top of the sort is bettable prices.
      if (sort.col === "prob") {
        const aIn = sa?.model.bestInWindow ?? false, bIn = sb?.model.bestInWindow ?? false;
        if (aIn !== bIn) return aIn ? -1 : 1;
      }
      let av, bv;
      switch (sort.col) {
        case "n":        av = a.n;               bv = b.n;               break;
        case "model":    av = sa?.model.modelProj;bv = sb?.model.modelProj;break;
        case "bestLine": av = sa?.model.bestLine; bv = sb?.model.bestLine; break;
        case "prob":     av = sa?.model.winProb;  bv = sb?.model.winProb;  break;
        case "fair":     av = sa?.model.fairOdds; bv = sb?.model.fairOdds; break;
        case "conf":     { const r = { high: 3, medium: 2, low: 1 }; av = r[sa?.model.confidence] ?? 0; bv = r[sb?.model.confidence] ?? 0; break; }
        case "l5avg":    av = sa?.l5avg;          bv = sb?.l5avg;          break;
        case "l10avg":   av = sa?.l10avg;         bv = sb?.l10avg;         break;
        case "_l5hr":    av = sa?.l5hr;           bv = sb?.l5hr;           break;
        case "_l10hr":   av = sa?.l10hr;          bv = sb?.l10hr;          break;
        case "_l20hr":   av = sa?.l20hr;          bv = sb?.l20hr;          break;
        case "pra":      av = a.pts+a.reb+a.ast;  bv = b.pts+b.reb+b.ast; break;
        case "sb":       av = a.stl+a.blk;        bv = b.stl+b.blk;       break;
        default:         av = a[sort.col];         bv = b[sort.col];       break;
      }
      if (sort.col === "n") return sort.dir === "desc" ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
      // Fair odds: lower (more negative) = higher probability = "better" in desc order
      if (sort.col === "fair") { if (av == null) return 1; if (bv == null) return -1; return sort.dir === "desc" ? av - bv : bv - av; }
      if (av == null) return 1;
      if (bv == null) return -1;
      return sort.dir === "desc" ? bv - av : av - bv;
    });
  }, [players, sort, search, teamFilter, todayOnly, todayTeams, allStats, selectedGame, injuryMap]);

  const todayCount = players.filter(p => todayTeams.has(p.t)).length;

  return (
    <div style={S.card}>
      <div style={S.cardHead}>
        <div style={S.cardTitle}>
          Player Scanner
          <span style={{ ...S.badge(), marginLeft: 8 }}>2026 PROJ</span>
        </div>
        <div style={{ fontSize: 10, color: "#7a8fa8", fontFamily: "monospace" }}>
          {sorted.length} players · Click row to expand game log
        </div>
      </div>

      {/* Prop type tabs */}
      <div style={S.propTabs}>
        {PROP_TABS.map(t => (
          <button key={t.id} onClick={() => { setPropTab(t.id); setSort({ col: "prob", dir: "desc" }); }}
            style={S.propTab(propTab === t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Search + filters */}
      <div style={S.searchWrap}>
        <input
          style={S.searchIn}
          placeholder="Search player…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          value={teamFilter}
          onChange={e => setTeamFilter(e.target.value)}
          style={{ background: "#0f1923", border: "1px solid #4a566e", borderRadius: 5, padding: "5px 8px", color: "#e2e8f0", fontSize: 11, cursor: "pointer" }}
        >
          {teams.map(t => <option key={t} value={t}>{t === "ALL" ? "All Teams" : (TEAM_META[t]?.full || t)}</option>)}
        </select>
        {todayCount > 0 && (
          <button
            onClick={() => setTodayOnly(v => !v)}
            style={todayOnly ? S.btnActive : S.btn}
          >
            <span style={{ fontSize: 9, color: todayOnly ? "#4ade80" : "#7dd3fc" }}>●</span>
            Today's Slate ({todayCount})
          </button>
        )}
      </div>

      {/* Table */}
      <div style={S.tbl}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...S.thLeft, textAlign: "left" }}>
                <SortBtn col="n" sort={sort} onSort={handleSort}>Player</SortBtn>
              </th>
              <th style={{ ...S.th, color: "#7dd3fc" }} title="Live prediction: a minutes-scaled, recency-weighted blend of the preseason baseline + real game logs (real data hits 50% weight at 12 GP), then matchup factors. This is the number to bet off.">
                <SortBtn col="model" sort={sort} onSort={handleSort}>Model</SortBtn>
              </th>
              <th style={S.th}>
                <SortBtn col="bestLine" sort={sort} onSort={handleSort}>Best Line</SortBtn>
              </th>
              <th style={S.th} title="Probability the model's side hits — max(P(over), P(under)). The O/U tag is which side that is, so sorting descending ranks overs and unders together by pure belief.">
                <SortBtn col="prob" sort={sort} onSort={handleSort}>Win%</SortBtn>
              </th>
              <th style={S.th} title="Fair American price for the side shown in Win% — always a favourite, since the model's side is by definition the >50% one.">
                <SortBtn col="fair" sort={sort} onSort={handleSort}>Fair</SortBtn>
              </th>
              <th style={S.th}>
                <SortBtn col="conf" sort={sort} onSort={handleSort}>Conf</SortBtn>
              </th>
              <th style={S.th}>
                <SortBtn col="l5avg" sort={sort} onSort={handleSort}>L5 Avg</SortBtn>
              </th>
              <th style={S.th}>
                <SortBtn col="l10avg" sort={sort} onSort={handleSort}>L10 Avg</SortBtn>
              </th>
              <th style={S.th}><SortBtn col="_l5hr"  sort={sort} onSort={handleSort}>L5 Hit%</SortBtn></th>
              <th style={S.th}><SortBtn col="_l10hr" sort={sort} onSort={handleSort}>L10 Hit%</SortBtn></th>
              <th style={S.th}><SortBtn col="_l20hr" sort={sort} onSort={handleSort}>L20 Hit%</SortBtn></th>
              <th style={{ ...S.th, color: "#7dd3fc66" }}><SortBtn col="pts"  sort={sort} onSort={handleSort}>S.PTS</SortBtn></th>
              <th style={{ ...S.th, color: "#7dd3fc66" }}><SortBtn col="reb"  sort={sort} onSort={handleSort}>S.REB</SortBtn></th>
              <th style={{ ...S.th, color: "#7dd3fc66" }}><SortBtn col="ast"  sort={sort} onSort={handleSort}>S.AST</SortBtn></th>
              <th style={{ ...S.th, color: "#7dd3fc66" }}><SortBtn col="fg3m" sort={sort} onSort={handleSort}>S.3PM</SortBtn></th>
              <th style={{ ...S.th, color: "#7dd3fc66" }}><SortBtn col="stl"  sort={sort} onSort={handleSort}>S.STL</SortBtn></th>
              <th style={{ ...S.th, color: "#7dd3fc66" }}><SortBtn col="blk"  sort={sort} onSort={handleSort}>S.BLK</SortBtn></th>
              <th style={{ ...S.th, width: 28 }}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(p => (
              <PlayerPropsRow
                key={p.n}
                player={p}
                propTab={propTab}
                sort={sort}
                espnTeams={espnTeams}
                expanded={expanded === p.n}
                onToggle={(name) => setExpanded(e => e === name ? null : name)}
                logCache={logCache}
                setLogCache={setLogCache}
                isToday={todayTeams.has(p.t)}
                matchup={todayMatchups[p.t] || null}
                teamStats={teamStats}
                seasonAvg={playerSeasonAvgs[normalizeName(p.n)] || null}
                injuryMap={injuryMap}
                advancedStats={advancedStats}
                modelCtx={modelCtx}
              />
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={15} style={{ padding: "24px", textAlign: "center", color: "#4a566e", fontSize: 12, fontFamily: "monospace" }}>
                  No players match current filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── PLAYERS TAB ───────────────────────────────────────────────────────────────
function PlayersTab({ players = PROJ_2026 }) {
  const [sort, setSort]             = useState({ col: "pts", dir: "desc" });
  const [search, setSearch]         = useState("");
  const [posFilter, setPosFilter]   = useState("ALL");
  const [teamFilter, setTeamFilter] = useState("ALL");

  function handleSort(col) {
    setSort(s => ({ col, dir: s.col === col && s.dir === "desc" ? "asc" : "desc" }));
  }

  const teams = useMemo(() => ["ALL", ...Array.from(new Set(players.map(p => p.t))).sort()], [players]);

  const sorted = useMemo(() => {
    const filtered = players.filter(p => {
      const nameOk = !search || normalizeName(p.n).includes(normalizeName(search));
      const posOk  = posFilter === "ALL" || p.pos === posFilter;
      const teamOk = teamFilter === "ALL" || p.t === teamFilter;
      return nameOk && posOk && teamOk;
    });
    return [...filtered].sort((a, b) => {
      const av = a[sort.col], bv = b[sort.col];
      if (av == null) return 1;
      if (bv == null) return -1;
      return sort.dir === "desc" ? bv - av : av - bv;
    });
  }, [players, sort, search, posFilter, teamFilter]);

  const COLS = [
    { id:"pts",  label:"PTS"  },
    { id:"reb",  label:"REB"  },
    { id:"ast",  label:"AST"  },
    { id:"fg3m", label:"3PM"  },
    { id:"stl",  label:"STL"  },
    { id:"blk",  label:"BLK"  },
    { id:"min",  label:"MIN"  },
  ];

  return (
    <div style={S.card}>
      <div style={S.cardHead}>
        <div style={S.cardTitle}>
          2026 Season Projections
          <span style={{ ...S.badge(), marginLeft: 8 }}>{players.length} PLAYERS</span>
        </div>
      </div>

      <div style={S.searchWrap}>
        <input style={S.searchIn} placeholder="Search player…" value={search} onChange={e => setSearch(e.target.value)} />
        <select value={posFilter} onChange={e => setPosFilter(e.target.value)}
          style={{ background: "#0f1923", border: "1px solid #4a566e", borderRadius: 5, padding: "5px 8px", color: "#e2e8f0", fontSize: 11, cursor: "pointer" }}>
          {["ALL","G","F","C"].map(p => <option key={p} value={p}>{p === "ALL" ? "All Pos" : p}</option>)}
        </select>
        <select value={teamFilter} onChange={e => setTeamFilter(e.target.value)}
          style={{ background: "#0f1923", border: "1px solid #4a566e", borderRadius: 5, padding: "5px 8px", color: "#e2e8f0", fontSize: 11, cursor: "pointer" }}>
          {teams.map(t => <option key={t} value={t}>{t === "ALL" ? "All Teams" : t}</option>)}
        </select>
      </div>

      <div style={S.tbl}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...S.thLeft, width: 40, textAlign: "center", minWidth: 40 }}>#</th>
              <th style={S.thLeft}>
                <SortBtn col="n" sort={sort} onSort={handleSort}>Player</SortBtn>
              </th>
              {COLS.map(c => (
                <th key={c.id} style={S.th}>
                  <SortBtn col={c.id} sort={sort} onSort={handleSort}>{c.label}</SortBtn>
                </th>
              ))}
              <th style={S.th}>PRA</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => {
              const tc = TEAM_META[p.t]?.color || "#7dd3fc";
              return (
                <tr key={p.n}
                  style={{ background: "transparent" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(125,211,252,0.03)"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <td style={{ ...S.tdLeft, textAlign: "center", color: "#64748b", fontSize: 11, fontFamily: "monospace", width: 40, minWidth: 40 }}>{i+1}</td>
                  <td style={S.tdLeft}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 3, height: 28, borderRadius: 2, background: tc, flexShrink: 0 }} />
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{p.n}</div>
                        <div style={{ fontSize: 10, color: "#7a8fa8" }}>
                          <span style={{ fontWeight: 600, color: tc }}>{p.t}</span> · {p.pos}
                        </div>
                      </div>
                    </div>
                  </td>
                  {COLS.map(c => (
                    <td key={c.id} style={{ ...S.td, color: sort.col === c.id ? "#7dd3fc" : "#e2e8f0", fontWeight: sort.col === c.id ? 700 : 400 }}>
                      {fmt1(p[c.id])}
                    </td>
                  ))}
                  <td style={{ ...S.td, color: "#7a8fa8" }}>{fmt1(p.pts + p.reb + p.ast)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── SCHEDULE TAB ──────────────────────────────────────────────────────────────
function ScheduleTab() {
  const [games, setGames]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [dateOffset, setDateOffset] = useState(0);

  const dateStr = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + dateOffset);
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
  }, [dateOffset]);

  const dateLabel = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + dateOffset);
    if (dateOffset === 0) return "Today";
    if (dateOffset === 1) return "Tomorrow";
    if (dateOffset === -1) return "Yesterday";
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }, [dateOffset]);

  useEffect(() => {
    setLoading(true);
    fetchSchedule(dateStr)
      .then(setGames)
      .catch(() => setGames([]))
      .finally(() => setLoading(false));
  }, [dateStr]);

  return (
    <div style={S.card}>
      <div style={S.cardHead}>
        <div style={S.cardTitle}>Schedule</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => setDateOffset(o => o-1)} style={{ ...S.btn, padding: "4px 10px" }}>‹</button>
          <span style={{ fontSize: 12, color: "#e2e8f0", minWidth: 80, textAlign: "center" }}>{dateLabel}</span>
          <button onClick={() => setDateOffset(o => o+1)} style={{ ...S.btn, padding: "4px 10px" }}>›</button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 32, textAlign: "center", color: "#64748b", fontSize: 12 }}>Loading schedule…</div>
      ) : games.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 14, color: "#7a8fa8" }}>No WNBA games scheduled</div>
          <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace", marginTop: 4 }}>Try another date</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12, padding: 12 }}>
          {games.map(g => <GameCard key={g.id} game={g} />)}
        </div>
      )}
    </div>
  );
}

function GameCard({ game }) {
  const homeTeam = game.home?.team;
  const awayTeam = game.away?.team;
  const homeAbbr = homeTeam?.abbreviation || "?";
  const awayAbbr = awayTeam?.abbreviation || "?";
  const homeScore = game.home?.score;
  const awayScore = game.away?.score;
  const isLive = game.statusState === "in";
  const isFinal = game.statusState === "post";
  const homeMeta = TEAM_META[homeAbbr] || {};
  const awayMeta = TEAM_META[awayAbbr] || {};

  return (
    <div style={{ background: "rgba(17,24,39,0.8)", border: `1px solid ${isLive ? "rgba(74,222,128,0.3)" : "#4a566e"}`, borderRadius: 8, overflow: "hidden", boxShadow: isLive ? "0 0 16px rgba(74,222,128,0.08)" : "0 2px 8px rgba(0,0,0,0.3)" }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid #4a566e", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 10, color: isLive ? "#4ade80" : isFinal ? "#7a8fa8" : "#7dd3fc", fontFamily: "monospace", fontWeight: 600 }}>
          {isLive ? "● LIVE" : isFinal ? "FINAL" : game.status || new Date(game.date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
        </span>
      </div>
      <div style={{ padding: "12px" }}>
        {[
          { team: awayTeam, abbr: awayAbbr, score: awayScore, meta: awayMeta, label: "Away" },
          { team: homeTeam, abbr: homeAbbr, score: homeScore, meta: homeMeta, label: "Home" },
        ].map(side => (
          <div key={side.abbr} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 4, height: 22, borderRadius: 2, background: side.meta.color || "#4a566e", display: "inline-block" }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{side.abbr}</div>
                <div style={{ fontSize: 10, color: "#7a8fa8" }}>{side.meta.full || side.team?.displayName || ""}</div>
              </div>
            </div>
            {(isLive || isFinal) && side.score != null && (
              <span style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace", color: "#e2e8f0" }}>{side.score}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── STANDINGS TAB ─────────────────────────────────────────────────────────────
function StandingsTab() {
  const [standings, setStandings] = useState([]);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    const url = "/espn-web/apis/v2/sports/basketball/wnba/standings?region=us&lang=en&contentorigin=espn&type=0&level=1&sort=winpercent%3Adesc%2Cwins%3Adesc%2Cgamesbehind%3Aasc";
    cacheFetch(url, 1_800_000)
      .then(data => {
        const entries = data.children?.[0]?.standings?.entries || data.standings?.entries || [];
        setStandings(entries.map(e => ({
          team: e.team?.abbreviation || "?",
          name: e.team?.displayName || "",
          stats: Object.fromEntries((e.stats || []).map(s => [s.name || s.abbreviation, s.displayValue || s.value])),
        })));
      })
      .catch(() => setStandings([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={S.card}>
      <div style={S.cardHead}>
        <div style={S.cardTitle}>
          Standings
          <span style={{ ...S.badge(), marginLeft: 8 }}>{ACTIVE_SEASON} SEASON</span>
        </div>
      </div>
      {loading ? (
        <div style={{ padding: 32, textAlign: "center", color: "#64748b", fontSize: 12 }}>Loading standings…</div>
      ) : standings.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: "#7a8fa8", fontSize: 12 }}>Standings unavailable</div>
      ) : (
        <div style={S.tbl}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["#","Team","W","L","PCT","GB","Home","Away","Streak"].map(h => (
                  <th key={h} style={h === "Team" ? S.thLeft : S.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {standings.map((s, i) => {
                const tc = TEAM_META[s.team]?.color || "#7dd3fc";
                const streak = s.stats.streak || s.stats.currentStreak || "--";
                return (
                  <tr key={s.team}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(125,211,252,0.03)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <td style={{ ...S.tdLeft, width: 36, textAlign: "center", color: "#64748b", fontSize: 11, fontFamily: "monospace" }}>{i+1}</td>
                    <td style={S.tdLeft}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 3, height: 22, borderRadius: 2, background: tc }} />
                        <div>
                          <span style={{ fontWeight: 600, color: tc }}>{s.team}</span>
                          <span style={{ color: "#7a8fa8", fontSize: 10, marginLeft: 6 }}>{TEAM_META[s.team]?.full || s.name}</span>
                        </div>
                      </div>
                    </td>
                    <td style={S.td}>{s.stats.wins || s.stats.W || "--"}</td>
                    <td style={S.td}>{s.stats.losses || s.stats.L || "--"}</td>
                    <td style={{ ...S.td, color: "#7dd3fc", fontWeight: 600 }}>{s.stats.winPercent || s.stats.PCT || "--"}</td>
                    <td style={S.td}>{s.stats.gamesBehind || s.stats.GB || "--"}</td>
                    <td style={{ ...S.td, fontSize: 11 }}>{s.stats.homeRecord || "--"}</td>
                    <td style={{ ...S.td, fontSize: 11 }}>{s.stats.awayRecord || "--"}</td>
                    <td style={S.td}>
                      <span style={{ color: typeof streak === "string" && streak.startsWith("W") ? "#4ade80" : "#f87171", fontWeight: 600, fontSize: 11 }}>
                        {streak}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── STAT LEADERS STRIP ────────────────────────────────────────────────────────
function StatLeaders({ players = PROJ_2026 }) {
  const leaders = useMemo(() => {
    const cats = [
      { label: "PTS", key: "pts" },
      { label: "REB", key: "reb" },
      { label: "AST", key: "ast" },
      { label: "3PM", key: "fg3m" },
      { label: "STL", key: "stl" },
      { label: "BLK", key: "blk" },
    ];
    return cats.map(c => {
      const top = [...players].sort((a, b) => (b[c.key] || 0) - (a[c.key] || 0)).slice(0, 3);
      return { ...c, top };
    });
  }, [players]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 12 }}>
      {leaders.map(cat => (
        <div key={cat.label} style={{ background: "rgba(26,37,53,0.7)", border: "1px solid #4a566e", borderRadius: 8, padding: "10px 12px", boxShadow: "0 2px 8px rgba(0,0,0,0.25)" }}>
          <div style={{ fontSize: 9, color: "#64748b", fontWeight: 700, textTransform: "uppercase", marginBottom: 8, letterSpacing: "0.08em" }}>
            {cat.label} Leaders
          </div>
          {cat.top.map((p, i) => {
            const tc = TEAM_META[p.t]?.color || "#7dd3fc";
            return (
              <div key={p.n} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", borderBottom: i < 2 ? "1px solid rgba(74,86,110,0.4)" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontSize: 9, color: "#4a566e", fontFamily: "monospace", width: 10 }}>{i+1}</span>
                  <span style={{ fontSize: 11, color: "#e2e8f0" }}>{p.n.split(" ").slice(-1)[0]}</span>
                  <span style={{ fontSize: 9, color: tc, fontWeight: 600 }}>{p.t}</span>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "monospace", color: i === 0 ? "#7dd3fc" : "#94a3b8" }}>{fmt1(p[cat.key])}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── RESULTS TAB ───────────────────────────────────────────────────────────────
// The nightly daily-predict.mjs loop records every model pick into wnba_picks,
// then grades it against the realized box score the next morning. This tab reads
// that forward, leakage-safe record back and breaks it down by confidence tier.

async function fetchAllPicks() {
  const rows = [];
  // PostgREST caps any single response at 1000 rows — paginate.
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(
      `${PICKS_REST}/wnba_picks?select=game_date,player,team,opp,stat,line,side,projection,prob_over,actual,hit,graded_at,model_version&order=game_date.desc&limit=1000&offset=${offset}`,
      { headers: { apikey: PICKS_ANON_KEY, Authorization: `Bearer ${PICKS_ANON_KEY}` } }
    );
    if (!r.ok) throw new Error(`picks ${r.status}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

// Confidence tier from the recorded win probability — mirrors the scanner's
// edge thresholds (edge = |P - 50%|; ≥15pp high, ≥7.5pp medium).
function pickTier(p) {
  const conf = Math.max(p, 1 - p);
  return conf >= 0.65 ? 'high' : conf >= 0.575 ? 'medium' : 'low';
}
const TIER_ORDER = ['high', 'medium', 'low'];

function recordOf(rows) {
  const n = rows.length;
  const w = rows.filter(r => r.hit).length;
  const brier = n ? rows.reduce((a, r) => {
    const conf = Math.max(r.prob_over, 1 - r.prob_over);
    return a + ((r.hit ? 1 : 0) - conf) ** 2;
  }, 0) / n : null;
  return { n, w, l: n - w, pct: n ? (100 * w) / n : null, brier };
}

function ResultsTab() {
  const [picks, setPicks]           = useState(null);
  const [error, setError]           = useState(null);
  const [verFilter, setVerFilter]   = useState("ALL");
  const [statFilter, setStatFilter] = useState("ALL");
  const [openDay, setOpenDay]       = useState(null);   // expanded slate in the daily scorecard

  useEffect(() => {
    fetchAllPicks().then(setPicks).catch(e => setError(String(e)));
  }, []);

  const versions = useMemo(
    () => picks ? Array.from(new Set(picks.map(r => r.model_version || '?'))).sort().reverse() : [],
    [picks]
  );

  const filtered = useMemo(() => {
    if (!picks) return [];
    return picks.filter(r =>
      (verFilter === "ALL" || (r.model_version || '?') === verFilter) &&
      (statFilter === "ALL" || r.stat === statFilter)
    );
  }, [picks, verFilter, statFilter]);

  const settled = useMemo(() => filtered.filter(r => r.hit != null), [filtered]);
  const pending = useMemo(() => filtered.filter(r => r.graded_at == null), [filtered]);
  const voided  = useMemo(() => filtered.filter(r => r.graded_at != null && r.hit == null), [filtered]);

  const overall  = useMemo(() => recordOf(settled), [settled]);
  const byTier   = useMemo(() => TIER_ORDER.map(t => ({ tier: t, ...recordOf(settled.filter(r => pickTier(r.prob_over) === t)) })), [settled]);
  const bySide   = useMemo(
    () => ['under', 'over'].map(s => ({ side: s, ...recordOf(settled.filter(r => r.side === s)) })),
    [settled]
  );
  const byStat   = useMemo(() => {
    const ids = Array.from(new Set(settled.map(r => r.stat)));
    return ids.map(id => ({ stat: id, ...recordOf(settled.filter(r => r.stat === id)) }))
      .sort((a, b) => b.n - a.n);
  }, [settled]);

  // Calibration: predicted confidence bucket vs realized hit rate.
  const calibration = useMemo(() => {
    const buckets = [[0.50, 0.55], [0.55, 0.60], [0.60, 0.65], [0.65, 0.70], [0.70, 1.01]];
    return buckets.map(([lo, hi]) => {
      const rows = settled.filter(r => { const c = Math.max(r.prob_over, 1 - r.prob_over); return c >= lo && c < hi; });
      const rec = recordOf(rows);
      const predicted = rows.length ? rows.reduce((a, r) => a + Math.max(r.prob_over, 1 - r.prob_over), 0) / rows.length : (lo + Math.min(hi, 0.75)) / 2;
      return { label: `${Math.round(lo * 100)}–${hi > 1 ? '100' : Math.round(hi * 100)}%`, predicted, ...rec };
    });
  }, [settled]);

  // Daily scorecard. The season % counts ONE thing — rows where hit != null — so
  // every slate also reports what was dropped (void = DNP/postponed, pending =
  // not yet graded) and how the counted rows split by side and tier. Without that
  // split the headline number is unreadable: the ledger is ~5:1 unders, so
  // "70% direction" is mostly a statement about the under side.
  const daily = useMemo(() => {
    const m = {};
    for (const r of filtered) (m[r.game_date] ||= []).push(r);
    return Object.entries(m).sort((a, b) => b[0].localeCompare(a[0])).map(([date, all]) => {
      const graded = all.filter(r => r.hit != null);
      return {
        date,
        ...recordOf(graded),
        over:  recordOf(graded.filter(r => r.side === 'over')),
        under: recordOf(graded.filter(r => r.side === 'under')),
        high:  recordOf(graded.filter(r => pickTier(r.prob_over) === 'high')),
        low:   recordOf(graded.filter(r => pickTier(r.prob_over) === 'low')),
        // ≥90% legs are near-locks — mostly unders on bench players who won't see
        // the minutes to reach the line. They're legitimately graded, but they pad
        // the headline %, so they get their own column instead of hiding in HIGH.
        lock:  recordOf(graded.filter(r => Math.max(r.prob_over, 1 - r.prob_over) >= 0.90)),
        voided:  all.filter(r => r.graded_at != null && r.hit == null).length,
        pending: all.filter(r => r.graded_at == null).length,
        rows: graded.slice().sort((a, b) =>
          Math.max(b.prob_over, 1 - b.prob_over) - Math.max(a.prob_over, 1 - a.prob_over)),
      };
    });
  }, [filtered]);

  const tierMeta = {
    high:   { label: "HIGH",   ...confStyle('high') },
    medium: { label: "MEDIUM", ...confStyle('medium') },
    low:    { label: "LOW",    ...confStyle('low') },
  };
  const pctClr = v => v == null ? "#7a8fa8" : v >= 55 ? "#4ade80" : v >= 50 ? "#fbbf24" : "#f87171";
  const cardBox = { background: "rgba(26,37,53,0.85)", border: "1px solid #4a566e", borderRadius: 10, padding: "12px 16px", minWidth: 150, flex: "1 1 150px" };
  const secHead = { fontSize: 9, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 };

  if (error) return (
    <div style={S.card}><div style={{ padding: 28, textAlign: "center", color: "#f87171", fontSize: 12, fontFamily: "monospace" }}>
      Couldn't load the picks record — {error}
    </div></div>
  );
  if (!picks) return (
    <div style={S.card}><div style={{ padding: 28, textAlign: "center", color: "#7a8fa8", fontSize: 12, fontFamily: "monospace" }}>
      Loading graded picks…
    </div></div>
  );

  return (
    <>
      {/* Summary cards */}
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={cardBox}>
          <div style={secHead}>Season record</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: "#e2e8f0" }}>
            {overall.w}<span style={{ color: "#4a566e" }}>-</span>{overall.l}
          </div>
          <div style={{ fontSize: 11, fontFamily: "monospace", color: pctClr(overall.pct), fontWeight: 700 }}>
            {overall.pct != null ? overall.pct.toFixed(1) + "% direction" : "no settled picks"}
          </div>
        </div>
        {byTier.filter(t => t.tier === 'high').map(t => (
          <div key={t.tier} style={cardBox}>
            <div style={secHead}>High tier (≥65%)</div>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: tierMeta.high.color }}>
              {t.w}<span style={{ color: "#4a566e" }}>-</span>{t.l}
            </div>
            <div style={{ fontSize: 11, fontFamily: "monospace", color: pctClr(t.pct), fontWeight: 700 }}>
              {t.pct != null ? t.pct.toFixed(1) + "% hit" : "—"}
            </div>
          </div>
        ))}
        <div style={cardBox}>
          <div style={secHead}>Brier score</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: overall.brier != null && overall.brier < 0.25 ? "#4ade80" : "#fbbf24" }}>
            {overall.brier != null ? overall.brier.toFixed(4) : "—"}
          </div>
          <div style={{ fontSize: 10, color: "#7a8fa8", fontFamily: "monospace" }}>vs .2500 coin-flip</div>
        </div>
        <div style={cardBox}>
          <div style={secHead}>Pipeline</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: "#7dd3fc" }}>{pending.length}</div>
          <div style={{ fontSize: 10, color: "#7a8fa8", fontFamily: "monospace" }}>pending · {voided.length} void (DNP)</div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <select value={verFilter} onChange={e => setVerFilter(e.target.value)}
          style={{ background: "#0f1923", border: "1px solid #4a566e", borderRadius: 5, padding: "5px 8px", color: "#e2e8f0", fontSize: 11, cursor: "pointer" }}>
          <option value="ALL">All model versions</option>
          {versions.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        {["ALL", ...PROP_TABS.map(t => t.id)].map(id => (
          <button key={id} onClick={() => setStatFilter(id)} style={S.propTab(statFilter === id)}>
            {id === "ALL" ? "ALL" : PROP_TABS.find(t => t.id === id)?.label || id.toUpperCase()}
          </button>
        ))}
        <span style={{ fontSize: 10, color: "#64748b", fontFamily: "monospace", marginLeft: "auto" }}>
          {settled.length} settled · graded nightly vs box scores
        </span>
      </div>

      {/* Tier + stat breakdown */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ ...S.card, flex: "1 1 340px", marginBottom: 12 }}>
          <div style={S.cardHead}><div style={S.cardTitle}>By Confidence Tier</div></div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Tier", "Picks", "Record", "Hit%", "Brier"].map((h, i) => (
                <th key={h} style={{ ...S.th, textAlign: i === 0 ? "left" : "center", cursor: "default" }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {byTier.map(t => {
                const m = tierMeta[t.tier];
                return (
                  <tr key={t.tier}>
                    <td style={{ ...S.tdLeft }}>
                      <span style={{ fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: m.bg, color: m.color, border: `1px solid ${m.border}`, letterSpacing: "0.04em" }}>{m.label}</span>
                    </td>
                    <td style={S.td}>{t.n}</td>
                    <td style={{ ...S.td, color: "#e2e8f0", fontWeight: 700 }}>{t.w}-{t.l}</td>
                    <td style={{ ...S.td, color: pctClr(t.pct), fontWeight: 700 }}>{t.pct != null ? t.pct.toFixed(1) + "%" : "—"}</td>
                    <td style={{ ...S.td, color: "#94a3b8" }}>{t.brier != null ? t.brier.toFixed(4) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ ...S.card, flex: "1 1 340px", marginBottom: 12 }}>
          <div style={S.cardHead}><div style={S.cardTitle}>By Stat</div></div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Stat", "Picks", "Record", "Hit%", "Brier"].map((h, i) => (
                <th key={h} style={{ ...S.th, textAlign: i === 0 ? "left" : "center", cursor: "default" }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {byStat.map(s => (
                <tr key={s.stat}>
                  <td style={{ ...S.tdLeft, fontFamily: "monospace", fontWeight: 700, color: "#7dd3fc", fontSize: 11, textTransform: "uppercase" }}>
                    {PROP_TABS.find(t => t.id === s.stat)?.label || s.stat}
                  </td>
                  <td style={S.td}>{s.n}</td>
                  <td style={{ ...S.td, color: "#e2e8f0", fontWeight: 700 }}>{s.w}-{s.l}</td>
                  <td style={{ ...S.td, color: pctClr(s.pct), fontWeight: 700 }}>{s.pct != null ? s.pct.toFixed(1) + "%" : "—"}</td>
                  <td style={{ ...S.td, color: "#94a3b8" }}>{s.brier != null ? s.brier.toFixed(4) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Calibration + daily trend */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ ...S.card, flex: "1 1 340px", marginBottom: 12 }}>
          <div style={S.cardHead}>
            <div style={S.cardTitle}>Calibration</div>
            <div style={{ fontSize: 10, color: "#7a8fa8", fontFamily: "monospace" }}>predicted vs realized</div>
          </div>
          {/* These rows are the LEDGER's recorded prob_over, which still carries the
              legacy continuity term — see pOverLine. The board above prices ~6pp
              higher on Normal stats until the shadow slate matures. Say so, rather
              than letting two different prices share one screen unlabelled. */}
          <div style={{ padding: "0 12px 8px", fontSize: 9, color: "#7dd3fc99" }}>
            Ledger-priced (legacy continuity term). The board prices Normal stats ~6pp higher — shadow slate pending.
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Conf bucket", "Picks", "Predicted", "Actual", "Δ"].map((h, i) => (
                <th key={h} style={{ ...S.th, textAlign: i === 0 ? "left" : "center", cursor: "default" }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {calibration.map(b => {
                const delta = b.n ? b.pct - b.predicted * 100 : null;
                return (
                  <tr key={b.label}>
                    <td style={{ ...S.tdLeft, fontFamily: "monospace", fontSize: 11, color: "#e2e8f0" }}>{b.label}</td>
                    <td style={S.td}>{b.n}</td>
                    <td style={{ ...S.td, color: "#94a3b8" }}>{b.n ? (b.predicted * 100).toFixed(1) + "%" : "—"}</td>
                    <td style={{ ...S.td, color: pctClr(b.pct), fontWeight: 700 }}>{b.n ? b.pct.toFixed(1) + "%" : "—"}</td>
                    <td style={{ ...S.td, color: delta == null ? "#4a566e" : Math.abs(delta) <= 3 ? "#4ade80" : delta > 0 ? "#7dd3fc" : "#f87171", fontWeight: 700 }}>
                      {delta == null ? "—" : (delta > 0 ? "+" : "") + delta.toFixed(1) + "pp"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ padding: "6px 12px 10px", fontSize: 9, color: "#64748b" }}>
            Well-calibrated = Δ near 0. Actual above predicted = the model is under-confident there (free edge); below = over-confident (fade or retune).
          </div>
        </div>

        <div style={{ ...S.card, flex: "1 1 340px", marginBottom: 12 }}>
          <div style={S.cardHead}>
            <div style={S.cardTitle}>By Side</div>
            <div style={{ fontSize: 10, color: "#7a8fa8", fontFamily: "monospace" }}>what the headline % is made of</div>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Side", "Picks", "Share", "Record", "Hit%"].map((h, i) => (
                <th key={h} style={{ ...S.th, textAlign: i === 0 ? "left" : "center", cursor: "default" }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {bySide.map(s => (
                <tr key={s.side}>
                  <td style={{ ...S.tdLeft, fontWeight: 700, fontSize: 11, color: s.side === "over" ? "#4ade80" : "#f472b6" }}>
                    {s.side === "over" ? "↑ OVER" : "↓ UNDER"}
                  </td>
                  <td style={S.td}>{s.n}</td>
                  <td style={{ ...S.td, color: "#94a3b8" }}>{overall.n ? Math.round(100 * s.n / overall.n) + "%" : "—"}</td>
                  <td style={{ ...S.td, color: "#e2e8f0", fontWeight: 700 }}>{s.w}-{s.l}</td>
                  <td style={{ ...S.td, color: pctClr(s.pct), fontWeight: 700 }}>{s.pct != null ? s.pct.toFixed(1) + "%" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: "6px 12px 10px", fontSize: 9, color: "#64748b" }}>
            Confidence is two-sided — it scores distance from a coin flip, so a HIGH badge on a low P(over) is a strong UNDER. If one side owns most of the picks, the season number is mostly that side's number.
          </div>
        </div>
      </div>

      {/* Daily scorecard — every slate, and exactly what got counted in it */}
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={S.cardHead}>
          <div style={S.cardTitle}>Daily Scorecard</div>
          <div style={{ fontSize: 10, color: "#7a8fa8", fontFamily: "monospace" }}>
            {daily.length} slates · click a row for the picks behind it
          </div>
        </div>
        <div style={{ padding: "0 12px 8px", fontSize: 9, color: "#64748b" }}>
          Counted = graded vs the box score (hit / miss). <span style={{ color: "#4a566e" }}>Void</span> (DNP or postponed)
          and <span style={{ color: "#7dd3fc" }}>pending</span> rows are shown but excluded from Hit% — they are the gap
          between "picks made" and "picks scored".
        </div>
        <div style={S.tbl}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Date", "Counted", "Record", "Hit%", "↑ Over", "↓ Under", "High tier", "Low tier", "Locks ≥90%", "Void", "Pend"].map((h, i) => (
                <th key={h} style={{ ...S.th, textAlign: i === 0 ? "left" : "center", cursor: "default" }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {daily.map(d => {
                const open = openDay === d.date;
                const cell = r => r.n ? `${r.w}-${r.l}` : "—";
                const cellPct = r => r.n ? ` (${r.pct.toFixed(0)}%)` : "";
                return (
                  <Fragment key={d.date}>
                    <tr onClick={() => setOpenDay(open ? null : d.date)}
                        style={{ cursor: "pointer", background: open ? "rgba(125,211,252,0.06)" : undefined }}>
                      <td style={{ ...S.tdLeft, fontFamily: "monospace", fontSize: 11, color: "#e2e8f0" }}>
                        <span style={{ color: "#4a566e", marginRight: 5 }}>{open ? "▾" : "▸"}</span>{d.date}
                      </td>
                      <td style={S.td}>{d.n}</td>
                      <td style={{ ...S.td, color: "#e2e8f0", fontWeight: 700 }}>{cell(d)}</td>
                      <td style={{ ...S.td, color: pctClr(d.pct), fontWeight: 700 }}>{d.pct != null ? d.pct.toFixed(0) + "%" : "—"}</td>
                      <td style={{ ...S.td, color: "#4ade80", fontSize: 10 }}>{cell(d.over)}<span style={{ color: "#64748b" }}>{cellPct(d.over)}</span></td>
                      <td style={{ ...S.td, color: "#f472b6", fontSize: 10 }}>{cell(d.under)}<span style={{ color: "#64748b" }}>{cellPct(d.under)}</span></td>
                      <td style={{ ...S.td, color: tierMeta.high.color, fontSize: 10 }}>{cell(d.high)}<span style={{ color: "#64748b" }}>{cellPct(d.high)}</span></td>
                      <td style={{ ...S.td, color: tierMeta.low.color, fontSize: 10 }}>{cell(d.low)}<span style={{ color: "#64748b" }}>{cellPct(d.low)}</span></td>
                      <td style={{ ...S.td, color: "#c4b5fd", fontSize: 10 }}>{cell(d.lock)}<span style={{ color: "#64748b" }}>{cellPct(d.lock)}</span></td>
                      <td style={{ ...S.td, color: d.voided ? "#94a3b8" : "#4a566e", fontSize: 10 }}>{d.voided || "—"}</td>
                      <td style={{ ...S.td, color: d.pending ? "#7dd3fc" : "#4a566e", fontSize: 10 }}>{d.pending || "—"}</td>
                    </tr>
                    {open && (
                      <tr>
                        {/* A full slate is 300+ graded legs — contain it rather than
                            growing the page by 8000px on every expand. */}
                        <td colSpan={11} style={{ padding: "0 0 10px", background: "rgba(15,25,35,0.6)", maxHeight: 340 }}>
                          <div style={{ maxHeight: 340, overflowY: "auto" }}>
                          {d.rows.length === 0
                            ? <div style={{ padding: 14, textAlign: "center", color: "#4a566e", fontSize: 11, fontFamily: "monospace" }}>
                                Nothing scored on this slate — {d.pending} pending, {d.voided} void.
                              </div>
                            : <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                <thead><tr>
                                  {["Player", "Stat", "Pick", "P(win)", "Tier", "Actual", "Result"].map((h, i) => (
                                    <th key={h} style={{ ...S.th, textAlign: i === 0 ? "left" : "center", cursor: "default", fontSize: 8 }}>{h}</th>
                                  ))}
                                </tr></thead>
                                <tbody>
                                  {d.rows.map((r, i) => {
                                    const conf = Math.max(r.prob_over, 1 - r.prob_over);
                                    const m = tierMeta[pickTier(r.prob_over)];
                                    return (
                                      <tr key={i}>
                                        <td style={S.tdLeft}>
                                          <span style={{ fontSize: 11, color: "#e2e8f0" }}>{r.player}</span>
                                          <span style={{ fontSize: 9, color: TEAM_META[r.team]?.color || "#7dd3fc", fontWeight: 700, marginLeft: 5 }}>{r.team}</span>
                                        </td>
                                        <td style={{ ...S.td, textTransform: "uppercase", fontSize: 9, color: "#7dd3fc", fontWeight: 700 }}>
                                          {PROP_TABS.find(t => t.id === r.stat)?.label || r.stat}
                                        </td>
                                        <td style={{ ...S.td, fontWeight: 700, fontSize: 10, color: r.side === "over" ? "#4ade80" : "#f472b6" }}>
                                          {r.side === "over" ? "↑ O" : "↓ U"} {r.line}
                                        </td>
                                        <td style={{ ...S.td, fontSize: 10, color: pctColor(Math.round(conf * 100)) }}>{Math.round(conf * 100)}%</td>
                                        <td style={S.td}>
                                          <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: m.bg, color: m.color, border: `1px solid ${m.border}` }}>{m.label}</span>
                                        </td>
                                        <td style={{ ...S.td, fontSize: 10, color: "#e2e8f0", fontWeight: 700 }}>{r.actual != null ? r.actual : "—"}</td>
                                        <td style={S.td}>
                                          {r.hit
                                            ? <span style={{ fontSize: 10, color: "#4ade80", fontWeight: 700 }}>✓ HIT</span>
                                            : <span style={{ fontSize: 10, color: "#f87171", fontWeight: 700 }}>✗ MISS</span>}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {daily.length === 0 && (
                <tr><td colSpan={11} style={{ padding: 20, textAlign: "center", color: "#4a566e", fontSize: 11, fontFamily: "monospace" }}>No slates yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent picks detail */}
      <div style={S.card}>
        <div style={S.cardHead}>
          <div style={S.cardTitle}>Latest Picks</div>
          <div style={{ fontSize: 10, color: "#7a8fa8", fontFamily: "monospace" }}>most recent 60 settled + today's pending</div>
        </div>
        <div style={S.tbl}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Date", "Player", "Stat", "Pick", "P(win)", "Tier", "Actual", "Result"].map((h, i) => (
                <th key={h} style={{ ...S.th, textAlign: i <= 1 ? "left" : "center", cursor: "default" }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {[...pending.slice(0, 40), ...settled.slice(0, 60)].map((r, i) => {
                const conf = Math.max(r.prob_over, 1 - r.prob_over);
                const tier = pickTier(r.prob_over);
                const m = tierMeta[tier];
                const teamColor = TEAM_META[r.team]?.color || "#7dd3fc";
                return (
                  <tr key={i}>
                    <td style={{ ...S.tdLeft, fontFamily: "monospace", fontSize: 10, color: "#94a3b8" }}>{r.game_date}</td>
                    <td style={S.tdLeft}>
                      <span style={{ fontSize: 11, color: "#e2e8f0" }}>{r.player}</span>
                      <span style={{ fontSize: 9, color: teamColor, fontWeight: 700, marginLeft: 5 }}>{r.team}</span>
                      <span style={{ fontSize: 9, color: "#4a566e", marginLeft: 4 }}>vs {r.opp}</span>
                    </td>
                    <td style={{ ...S.td, textTransform: "uppercase", fontSize: 10, color: "#7dd3fc", fontWeight: 700 }}>
                      {PROP_TABS.find(t => t.id === r.stat)?.label || r.stat}
                    </td>
                    <td style={{ ...S.td, fontWeight: 700, color: r.side === "over" ? "#4ade80" : "#f472b6" }}>
                      {r.side === "over" ? "O" : "U"} {r.line}
                    </td>
                    <td style={{ ...S.td, color: pctColor(Math.round(conf * 100)) }}>{Math.round(conf * 100)}%</td>
                    <td style={S.td}>
                      <span style={{ fontSize: 8, fontWeight: 700, padding: "2px 5px", borderRadius: 3, background: m.bg, color: m.color, border: `1px solid ${m.border}` }}>{m.label}</span>
                    </td>
                    <td style={{ ...S.td, color: "#e2e8f0" }}>{r.actual != null ? r.actual : "—"}</td>
                    <td style={S.td}>
                      {r.graded_at == null
                        ? <span style={{ fontSize: 9, color: "#7dd3fc", fontFamily: "monospace" }}>PENDING</span>
                        : r.hit == null
                        ? <span style={{ fontSize: 9, color: "#4a566e", fontFamily: "monospace" }}>VOID</span>
                        : r.hit
                        ? <span style={{ fontSize: 11, color: "#4ade80", fontWeight: 700 }}>✓ HIT</span>
                        : <span style={{ fontSize: 11, color: "#f87171", fontWeight: 700 }}>✗ MISS</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab]               = useState("props");
  const [espnTeams, setEspnTeams]   = useState([]);
  const [logCache, setLogCache]     = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [todayGames, setTodayGames] = useState([]);
  const [slateLoading, setSlateLoading] = useState(true);
  const [teamStats, setTeamStats]   = useState({});
  const [playerSeasonAvgs, setPlayerSeasonAvgs] = useState({});
  const [selectedGame, setSelectedGame] = useState(null);
  const [injuryMap, setInjuryMap]   = useState({});
  const [advancedStats, setAdvancedStats] = useState({});
  const [teamAdvanced, setTeamAdvanced]   = useState({});  // real pace / off-def rating
  const [teamOpponent, setTeamOpponent]   = useState({});  // real opponent-allowed (defense)
  const [playerScoring, setPlayerScoring] = useState({});  // shot-profile / assisted share
  const [gravity, setGravity]             = useState({});  // AWS Inside the Game gravity
  const [liveRoster, setLiveRoster]       = useState([]);  // stats.wnba.com full-league roster
  const logsPreloadedRef = useRef(false);

  // Advanced-stats context handed to every buildWNBAModel call. leagueAvg is recomputed
  // from live team data so the opponent/pace multipliers self-calibrate through the season.
  // When the official Opponent/Advanced team tables are unreachable (prod bot-wall),
  // fall back to the same layer derived from our own cached box scores.
  const modelCtx = useMemo(() => {
    const haveOfficial = Object.keys(teamOpponent).length >= 8;
    const derived = haveOfficial ? null : deriveTeamStatsFromLogs(logCache);
    const tOpp = haveOfficial ? teamOpponent : (derived?.teamOpponent ?? {});
    const tAdv = Object.keys(teamAdvanced).length >= 8 ? teamAdvanced : (derived?.teamAdvanced ?? {});
    return {
      teamAdvanced: tAdv, teamOpponent: tOpp, playerScoring, advanced: advancedStats,
      gravity, teamGravity: computeTeamGravity(gravity),
      leagueAvg: computeModelLeagueAvg(tOpp, tAdv),
    };
  }, [teamAdvanced, teamOpponent, playerScoring, advancedStats, gravity, logCache]);

  // { teamAbbr → { opponent, isHome } } for players with a game tonight
  const todayMatchups = useMemo(() => {
    const m = {};
    todayGames.forEach(g => {
      const ha = g.home?.team?.abbreviation;
      const aa = g.away?.team?.abbreviation;
      if (ha && aa) { m[ha] = { opponent: aa, isHome: true }; m[aa] = { opponent: ha, isHome: false }; }
    });
    return m;
  }, [todayGames]);

  const todayTeams = useMemo(() => new Set(Object.keys(todayMatchups)), [todayMatchups]);

  const effectivePlayers = useMemo(() => mergeLiveRoster(liveRoster), [liveRoster]);

  useEffect(() => {
    fetchAllTeams()
      .then(teams => { setEspnTeams(teams); setLastUpdated(new Date()); })
      .catch(() => {});

    fetchSchedule(todayStr())
      .then(setTodayGames)
      .catch(() => setTodayGames([]))
      .finally(() => setSlateLoading(false));

    // ESPN team stats for pace/defense adjustments
    fetchWNBAESPNTeamStats()
      .then(setTeamStats)
      .catch(() => {});

    // 2025 player season averages — populates model on first render
    fetchWNBAPlayerSeasonAvgs()
      .then(setPlayerSeasonAvgs)
      .catch(() => {});

    // Live roster — derived from ESPN box scores (stats.nba.com is Akamai-blocked from
    // Vercel's serverless egress, so the /api/nba-stats relay times out in prod). Catches
    // rotation players the frozen PROJ_2026 seed missed (trades, rookies, 2026 expansion).
    fetchWNBABoxScoreLogs(50)
      .then(({ roster }) => setLiveRoster(roster))
      .catch(() => {});

    // Advanced stats — USG%, TS%, eFG% etc.
    fetchWNBAAdvancedStats().then(setAdvancedStats).catch(() => {});

    // Advanced model layer — real pace, opponent-allowed defense, player scoring profile.
    fetchWNBATeamAdvanced().then(setTeamAdvanced).catch(() => {});
    fetchWNBATeamOpponent().then(setTeamOpponent).catch(() => {});
    fetchWNBAPlayerScoring().then(setPlayerScoring).catch(() => {});

    // Gravity — AWS Inside the Game defensive-attention scores.
    fetchWNBAGravity().then(setGravity).catch(() => {});
  }, []);

  // Backfill game logs once the player pool is known. Runs again when effectivePlayers
  // grows (live-roster additions land a beat after mount) — cheap re-run, nbaProxyFetch
  // caches the underlying requests for 15min so this is just the local cache-merge loop.
  useEffect(() => {
    // Full-season game logs from ESPN boxscores (fast, CORS-friendly). Cached from the
    // mount-effect roster fetch, so this is just the local cache-merge loop.
    fetchWNBABoxScoreLogs(50).then(({ logs: normLogs }) => {
      setLogCache(prev => {
        const next = { ...prev };
        for (const p of effectivePlayers) {
          if (next[p.n] != null) continue;
          const logs = normLogs[normalizeName(p.n)];
          if (logs != null) next[p.n] = { logs, season: ACTIVE_SEASON };
        }
        return next;
      });
    }).catch(() => {});

    // NBA API game logs via Supabase proxy — authoritative source, overwrites ESPN data
    fetchWNBALeagueGameLog().then(normLogs => {
      setLogCache(prev => {
        const next = { ...prev };
        for (const p of effectivePlayers) {
          const logs = normLogs[normalizeName(p.n)];
          if (logs != null && logs.length > 0) next[p.n] = { logs, season: ACTIVE_SEASON };
        }
        return next;
      });
    }).catch(() => {});
  }, [effectivePlayers]);

  // Fetch injury statuses once today's slate is known
  useEffect(() => {
    if (todayTeams.size === 0 || logsPreloadedRef.current) return;
    logsPreloadedRef.current = true;
    fetchInjuryStatuses([...todayTeams]).then(setInjuryMap).catch(() => {});
  }, [todayTeams]);

  function handleSelectGame(game) {
    setSelectedGame(game ?? null);
  }

  async function handleRefresh() {
    setRefreshing(true);
    _cache.clear();
    setSlateLoading(true);
    try {
      const [teams, games, stats, avgs, box, nbaLogs, adv, tAdv, tOpp, pScore, grav] = await Promise.all([
        fetchAllTeams(),
        fetchSchedule(todayStr()),
        fetchWNBAESPNTeamStats(),
        fetchWNBAPlayerSeasonAvgs(),
        fetchWNBABoxScoreLogs(50),
        fetchWNBALeagueGameLog().catch(() => ({})),
        fetchWNBAAdvancedStats().catch(() => ({})),
        fetchWNBATeamAdvanced().catch(() => ({})),
        fetchWNBATeamOpponent().catch(() => ({})),
        fetchWNBAPlayerScoring().catch(() => ({})),
        fetchWNBAGravity().catch(() => ({})),
      ]);
      const espnLogs = box.logs;
      const roster = box.roster;
      setEspnTeams(teams);
      setTodayGames(games);
      setTeamStats(stats);
      setPlayerSeasonAvgs(avgs);
      setLiveRoster(roster);
      setAdvancedStats(adv);
      setTeamAdvanced(tAdv);
      setTeamOpponent(tOpp);
      setPlayerScoring(pScore);
      setGravity(grav);
      // Rebuild log cache: ESPN first, then NBA API overwrites (more authoritative)
      const freshLogs = {};
      for (const p of mergeLiveRoster(roster)) {
        const espn = espnLogs[normalizeName(p.n)];
        if (espn != null) freshLogs[p.n] = { logs: espn, season: ACTIVE_SEASON };
        const nba = nbaLogs[normalizeName(p.n)];
        if (nba != null && nba.length > 0) freshLogs[p.n] = { logs: nba, season: ACTIVE_SEASON };
      }
      setLogCache(freshLogs);
      setSelectedGame(null);
      logsPreloadedRef.current = false;
      setLastUpdated(new Date());
    } catch {}
    setRefreshing(false);
    setSlateLoading(false);
  }

  const TABS = [
    { id: "props",    label: "Player Scanner" },
    { id: "results",  label: "Results" },
    { id: "players",  label: "Players" },
    { id: "schedule", label: "Schedule" },
    { id: "standings",label: "Standings" },
  ];

  return (
    <div style={S.wrap}>
      {/* Background elements */}
      <div style={S.grid} />
      <div style={S.glow} />

      <div style={S.content}>
        {/* Header */}
        <header style={S.header}>
          <div style={S.hRow}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <SportSwitcher />
              <div>
              <div style={S.title}>
                🏀 WNBA Research Dashboard
                <span style={S.badge("live")}>IN SEASON</span>
                <span style={S.badge()}>{ACTIVE_SEASON}</span>
              </div>
              <div style={S.subtitle}>
                {ACTIVE_SEASON} season · ESPN + stats.wnba.com · {effectivePlayers.length} players projected
              </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {lastUpdated && (
                <span style={{ fontSize: 9, color: "#64748b", fontFamily: "monospace" }}>
                  updated {lastUpdated.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              <button
                style={{ ...S.btn, opacity: refreshing ? 0.6 : 1 }}
                onClick={handleRefresh}
                disabled={refreshing}
              >
                <span style={{ display: "inline-block", animation: refreshing ? "spin 1s linear infinite" : "none" }}>↻</span>
                Refresh
              </button>
            </div>
          </div>
        </header>

        <main style={S.main}>
          {/* Tab nav */}
          <div style={S.tabNav}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={S.tabBtn(tab === t.id)}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Today's slate (props + schedule tabs) */}
          {(tab === "props" || tab === "schedule") && (
            <TodaySlate games={todayGames} loading={slateLoading} selectedGame={selectedGame} onSelectGame={handleSelectGame} />
          )}

          {/* Stat leaders strip */}
          {(tab === "props" || tab === "players") && <StatLeaders players={effectivePlayers} />}

          {tab === "props"     && <PropsScanner players={effectivePlayers} espnTeams={espnTeams} logCache={logCache} setLogCache={setLogCache} todayTeams={todayTeams} todayMatchups={todayMatchups} teamStats={teamStats} playerSeasonAvgs={playerSeasonAvgs} selectedGame={selectedGame} injuryMap={injuryMap} advancedStats={advancedStats} modelCtx={modelCtx} />}
          {tab === "results"   && <ResultsTab />}
          {tab === "players"   && <PlayersTab players={effectivePlayers} />}
          {tab === "schedule"  && <ScheduleTab />}
          {tab === "standings" && <StandingsTab />}
        </main>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        button { transition: all 0.15s; }
        button:hover { opacity: 0.85; }
        input:focus { border-color: rgba(125,211,252,0.5) !important; }
        select option { background: #1a2535; }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}
