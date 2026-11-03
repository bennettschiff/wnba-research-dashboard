# WNBA Research Dashboard

A daily WNBA player research dashboard: projections for points, rebounds,
assists, threes and combos, matchup and pace context, a probability ladder at
every common line, and a nightly job that writes each projection to a ledger
and grades it the next morning.

**Live:** https://wnba.schiffpicks.com · React 19 · Vite · Vercel · Supabase · GitHub Actions

> **About this repository.** This is a public showcase copy of a private repo.
> It contains the real UI, the nightly predict-and-grade job, the stats proxy,
> and the test suite. **The production model and its calibration are private.**
> `buildWNBAModel` in `src/App.jsx` and `predictStat` in
> `scripts/wnba-model.mjs` are structural stand-ins: same inputs and output
> shapes, simple math (projection blended with recency-weighted game logs,
> one opponent factor, Normal/Poisson pricing) and illustrative constants.
> The research lab, promotion pipeline and git history are not included.

<!-- Screenshot: add docs/screenshot.png and uncomment
![WNBA Research Dashboard](docs/screenshot.png)
-->

## What it does

- **Player scanner.** Every player on tonight's slate with a projection, a
  spread (σ), the line nearest a coin flip, and the side the model leans,
  sortable by how strongly it leans.
- **Player panel.** Game log, splits, and every adjustment the projection
  applied, shown as labeled multipliers.
- **Schedule, standings, leaders,** all from public ESPN and league feeds.
- **Results.** The nightly ledger: record and calibration by stat and tier.

## Architecture

```
 Browser (React SPA) ── Vercel ── rewrites ──► ESPN site/core APIs
          │                     └ /api/nba-stats ──► stats.wnba.com (bot-walled)
          │
          └── publishable key ──► Supabase (wnba_picks, read-only via RLS)
                                         ▲ service role
 GitHub Actions (nightly) ── scripts/daily-predict.mjs: grade yesterday,
                                         predict today, write the ledger
                           ── scripts/backup-to-drive.mjs: Postgres → Drive
```

One detail worth pointing at: the league stats endpoint sits behind a bot
wall that blocks browsers by origin and blocks curl and Deno by TLS
fingerprint, but lets Node's `fetch` through. `api/nba-stats.js` is a
same-origin allow-listed relay that exploits exactly that, and the nightly
job falls back to a Supabase edge proxy when a region is blocked.

## Where to look

| Area | Files |
|---|---|
| The board, player panel, and model stand-in | `src/App.jsx` |
| Nightly predict + grade, and the ledger row it writes | `scripts/daily-predict.mjs`, `scripts/wnba-model.mjs` |
| Which projections become official picks | `scripts/lib/official-pick.mjs`, `scripts/lib/gate-overrides.mjs` |
| Pricing conventions pinned to the model version | `scripts/lib/model-version.test.mjs`, `scripts/lib/pricing.test.mjs` |
| Retrying Supabase client with a guard test that every scheduled script uses it | `scripts/lib/sb-fetch.mjs`, `scripts/lib/sb-fetch.guard.test.mjs` |
| Backup with gap detection | `scripts/backup-to-drive.mjs`, `scripts/prune-backups.mjs` |

## Running it

```bash
npm ci
npm test        # node --test, no network or keys needed
npm run build
npm run dev     # http://localhost:5173
```

The UI reads public ESPN data through Vite/Vercel rewrites. The stats proxy
fallback and the Results tab need `.env.local` (see `.env.example`).

## License

All rights reserved. The code is published for viewing and evaluation; see [LICENSE](LICENSE).
