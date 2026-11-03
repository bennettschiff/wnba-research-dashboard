#!/usr/bin/env node
/**
 * Nightly Supabase backup dump for the WNBA Research Dashboard.
 * Shares the same Supabase project as MLB (same SUPABASE_URL / SERVICE_ROLE_KEY).
 * Backups land in a separate "wnba-research-dashboard-backups" Drive folder.
 *
 * Local run — note the env-file form. `set -a; source .env.local` is blocked by
 * .claude/hooks/block-prompt-tripwires.mjs because it forces a permission prompt
 * that an unattended routine would hang on forever:
 *
 *   node --env-file=.env.local scripts/backup-to-drive.mjs --out-dir=backup-out
 *   rclone copy backup-out gdrive:wnba-research-dashboard-backups/2026-08-31
 *
 * The destination is a NEW DATED FOLDER every night, which is right for a
 * rolling snapshot of a live table and wrong for anything pay-once. The odds
 * archive deliberately does not use this scheme — see the TABLES comment below.
 * Retention is enforced by the prune step in .github/workflows/backup-to-drive.yml.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { sbFetch } from "./lib/sb-fetch.mjs";

// The pay-once Odds API archive is deliberately NOT here. It lives on Drive at
// gdrive:wnba-research-dashboard-archive/historical-odds/ and never enters Supabase —
// 40k rows cost 31 MB in Postgres vs 0.29 MB gzipped, and that project is on
// the free plan's 500 MB ceiling. Managed by scripts/odds-archive.mjs.
const TABLES = {
  wnba_picks: { order: "id", page: 1000 },
};

const CSV_TABLES = ["wnba_picks"];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith("--"))
    .map(a => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; })
);
const outDir   = args["out-dir"] || "backup-out";
const onlyTbls = args["tables"] ? args["tables"].split(",").map(s => s.trim()) : null;
// ISO instant of the snapshot already sitting in today's Drive folder, passed by
// the workflow's backstop run. See wouldChangeNothing() below.
const changedSince = typeof args["changed-since"] === "string" ? args["changed-since"] : null;
fs.mkdirSync(outDir, { recursive: true });

/**
 * Would this run write the same snapshot that is already on Drive?
 *
 * Two cron slots dump this table every day (08:45 and 16:12 UTC) into the SAME
 * dated folder, so the second overwrites the first. That second slot exists as a
 * genuine retry — a scheduled run GitHub drops never starts and so never fails —
 * but on the ordinary day where the first slot ran, it re-downloaded all 17,496
 * rows to write a file byte-for-byte identical to the one already there. At
 * ~8 MB of Supabase egress a pass that is 15.85 MB/day, the largest single item
 * in this repo's budget, on an org that exceeded the free plan's egress quota on
 * 2026-09-05.
 *
 * So the backstop now asks one question first, for about 200 bytes: has any row
 * been created or graded since the snapshot on Drive was written? Only two things
 * mutate this table — daily-predict's upsert and the grading pass — and both
 * stamp created_at or graded_at, so a "no" means the existing snapshot is still
 * an exact copy and re-uploading it buys nothing.
 *
 * The retry property is untouched: the workflow only passes --changed-since when
 * it has actually seen today's folder on Drive. A dropped primary run leaves no
 * folder, the flag is absent, and the backstop dumps unconditionally.
 *
 * This can only ever SKIP writing a byte-identical file. If the probe fails for
 * any reason it returns false and the dump proceeds — a redundant backup is a
 * non-event, a missing one is not.
 */
async function wouldChangeNothing(since) {
  const qs = `select=id&limit=1&or=(created_at.gte.${encodeURIComponent(since)},graded_at.gte.${encodeURIComponent(since)})`;
  try {
    const res = await sbFetch(`${SUPABASE_URL}/rest/v1/wnba_picks?${qs}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!res.ok) {
      console.warn(`  change probe returned ${res.status} — dumping anyway`);
      return false;
    }
    const rows = await res.json();
    return Array.isArray(rows) && rows.length === 0;
  } catch (e) {
    console.warn(`  change probe failed (${e.message}) — dumping anyway`);
    return false;
  }
}

async function fetchPage(table, order, page, offset) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=*&order=${order}&limit=${page}&offset=${offset}`;
  const res  = await sbFetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${table} offset=${offset}`);
  return res.json();
}

async function dumpTable(table, { order, page }) {
  const rows = [];
  let offset = 0;
  while (true) {
    const chunk = await fetchPage(table, order, page, offset);
    rows.push(...chunk);
    if (chunk.length < page) break;
    offset += page;
  }
  console.log(`  ${table}: ${rows.length} rows`);

  const json = JSON.stringify(rows);
  const gzipped = json.length > 2_000_000;
  const outBase = path.join(outDir, table);
  if (gzipped) {
    const gz = zlib.gzipSync(Buffer.from(json));
    fs.writeFileSync(outBase + ".json.gz", gz);
  } else {
    fs.writeFileSync(outBase + ".json", json);
  }

  if (CSV_TABLES.includes(table) && rows.length > 0) {
    const cols = Object.keys(rows[0]);
    const csvLines = [
      cols.join(","),
      ...rows.map(r => cols.map(c => {
        const v = r[c] == null ? "" : String(r[c]);
        return v.includes(",") || v.includes('"') || v.includes("\n")
          ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(",")),
    ];
    fs.writeFileSync(outBase + ".csv", csvLines.join("\n"));
  }
}

const tables = onlyTbls
  ? onlyTbls.filter(t => TABLES[t])
  : Object.keys(TABLES);

if (changedSince && await wouldChangeNothing(changedSince)) {
  console.log(
    `Nothing created or graded since ${changedSince} — today's Drive snapshot is ` +
    `already an exact copy. Skipping the dump (nothing written to ${outDir}/).`
  );
  process.exit(0);
}

console.log(`Backing up ${tables.length} WNBA tables → ${outDir}/`);
for (const t of tables) await dumpTable(t, TABLES[t]);
console.log("Done.");
