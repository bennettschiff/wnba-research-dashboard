#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Manage the WNBA odds archive on Drive. See scripts/lib/odds-archive.mjs for
// why it does not live in Supabase.
//
//   node --env-file=.env.local scripts/odds-archive.mjs --from-supabase  # migrate out
//   node scripts/odds-archive.mjs --push                                 # local → Drive
//   node scripts/odds-archive.mjs --pull                                 # Drive → local
//   node scripts/odds-archive.mjs --stats                                # what's in it
// ─────────────────────────────────────────────────────────────────────────────

import { statSync, existsSync } from "node:fs";
import {
  ARCHIVE_PATH, DRIVE_REMOTE, readArchive, writeArchive, mergeRows,
  pushToDrive, pullFromDrive,
} from "./lib/odds-archive.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

if (has("--from-supabase")) {
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${URL}/rest/v1/wnba_historical_odds?select=*&order=id.asc&limit=1000&offset=${off}`, { headers: H });
    if (!r.ok) { console.error(`${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
    const chunk = await r.json();
    rows.push(...chunk);
    process.stdout.write(`\r  exported ${rows.length} rows…`);
    if (chunk.length < 1000) break;
  }
  // Drop the Postgres-only columns; the archive is the data, not the table.
  const clean = rows.map(({ id, created_at, ...keep }) => keep);
  const existing = existsSync(ARCHIVE_PATH) ? readArchive({ autoPull: false }) : [];
  const merged = mergeRows(existing, clean);
  writeArchive(merged);
  console.log(`\n  wrote ${merged.length} rows → ${ARCHIVE_PATH}`);
  console.log(`  ${(statSync(ARCHIVE_PATH).size / 1024 / 1024).toFixed(2)} MB gzipped`);
}

if (has("--push")) {
  const remote = pushToDrive();
  console.log(`pushed → ${DRIVE_REMOTE}/${remote.Name}  (${(remote.Size / 1024 / 1024).toFixed(2)} MB, ${remote.ModTime})`);
}

if (has("--pull")) {
  pullFromDrive();
  console.log(`pulled ${DRIVE_REMOTE} → ${ARCHIVE_PATH}`);
}

if (has("--stats") || argv.length === 0) {
  const rows = readArchive();
  const byMarket = {}, byBook = {}, games = new Set(), dates = new Set();
  for (const r of rows) {
    byMarket[r.prop_type] = (byMarket[r.prop_type] || 0) + 1;
    byBook[r.book] = (byBook[r.book] || 0) + 1;
    games.add(r.espn_game_id); dates.add(r.game_date);
  }
  const d = [...dates].sort();
  console.log(`\nWNBA odds archive · ${ARCHIVE_PATH}`);
  console.log(`  ${(statSync(ARCHIVE_PATH).size / 1024 / 1024).toFixed(2)} MB gzipped`);
  console.log(`  ${rows.length} rows · ${games.size} games · ${d[0]} → ${d[d.length - 1]}\n`);
  console.log("  market                          rows");
  for (const [k, v] of Object.entries(byMarket).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)}${String(v).padStart(6)}`);
  console.log("\n  book                            rows");
  for (const [k, v] of Object.entries(byBook).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)}${String(v).padStart(6)}`);
}
