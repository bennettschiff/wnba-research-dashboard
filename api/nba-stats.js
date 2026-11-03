// Same-origin stats proxy (Vercel serverless, Node runtime).
//
// stats.nba.com sits behind an Akamai bot-wall that blocks by TLS fingerprint +
// Origin header: browser fetches from our own origin hang, curl and Deno (Supabase
// edge) are blocked outright — but Node's fetch (undici) passes. So the app calls
// this function same-origin and it relays with the header pack the wall expects.
// Also relays the Gravity feed (www.wnba.com/api), whose CORS is locked to wnba.com.
//
//   /api/nba-stats?endpoint=leaguedashteamstats&LeagueID=10&...
//   /api/nba-stats?endpoint=gravity&season=2026&seasonType=Regular%20Season

const STATS_ALLOWED = new Set([
  'leaguegamelog',
  'leaguedashplayerstats',
  'leaguedashteamstats',
  'leaguedashptstats',
  'playergamelogs',
]);

const STATS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.wnba.com/',
  'Origin': 'https://www.wnba.com',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
};

export default async function handler(req, res) {
  const { endpoint = '', ...params } = req.query;

  let target, headers;
  if (endpoint === 'gravity') {
    target = new URL('https://www.wnba.com/api/gravity/leaders');
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, String(v));
    if (!target.searchParams.get('season')) target.searchParams.set('season', String(new Date().getFullYear()));
    if (!target.searchParams.get('seasonType')) target.searchParams.set('seasonType', 'Regular Season');
    headers = { 'User-Agent': STATS_HEADERS['User-Agent'], Accept: 'application/json', Referer: 'https://www.wnba.com/stats/inside-the-game/gravity' };
  } else if (STATS_ALLOWED.has(endpoint)) {
    target = new URL(`https://stats.nba.com/stats/${endpoint}`);
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, String(v));
    headers = STATS_HEADERS;
  } else {
    return res.status(400).json({ error: `unknown endpoint '${endpoint}'` });
  }

  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20_000);
    const r = await fetch(target.toString(), { headers, signal: ac.signal });
    clearTimeout(t);
    const body = await r.text();
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    res.setHeader('Content-Type', 'application/json');
    return res.status(r.status).send(body);
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
}
