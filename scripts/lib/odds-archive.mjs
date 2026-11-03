// ─────────────────────────────────────────────────────────────────────────────
// The WNBA odds archive lives on Google Drive, NOT in Supabase.
//
// The shared Supabase project is on the free plan's 500 MB ceiling (two active
// projects, read-only past it) and was already at 274 MB. 40k odds rows cost
// 31 MB there (18 MB heap + 13 MB of index) and every future pull would add
// more, so the pay-once archive lives on Drive with a local working copy.
//
//   Drive (durable)  gdrive:wnba-research-dashboard-archive/historical-odds/
//   local (working)  scripts/out/wnba_historical_odds.jsonl.gz   [gitignored]
//   Supabase         nothing
//
// This is the ONE place that knows the archive's shape, path and dedup key —
// the puller and validate-market both go through here so they cannot drift.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ARCHIVE_PATH = join(ROOT, "scripts", "out", "wnba_historical_odds.jsonl.gz");
export const DRIVE_REMOTE = "gdrive:wnba-research-dashboard-archive/historical-odds";

// Must match the old Supabase unique index exactly, or a re-pull silently
// duplicates rows instead of replacing them.
export const rowKey = (r) =>
  `${r.espn_game_id}|${r.book}|${r.prop_type}|${r.player_name}|${r.name}|${r.line ?? ""}`;

/** Merge incoming rows over existing ones, last-write-wins on the unique key. */
export function mergeRows(existing, incoming) {
  const m = new Map();
  for (const r of existing) m.set(rowKey(r), r);
  for (const r of incoming) m.set(rowKey(r), r);
  return [...m.values()];
}

export function writeArchive(rows) {
  mkdirSync(dirname(ARCHIVE_PATH), { recursive: true });
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(ARCHIVE_PATH, zlib.gzipSync(Buffer.from(jsonl), { level: 9 }));
  return rows.length;
}

/**
 * Read the archive. If the local copy is missing (fresh checkout, CI), pull it
 * from Drive first — the whole point of moving it off Supabase is that Drive is
 * the durable copy, so a missing local file is recoverable, not fatal.
 */
export function readArchive({ autoPull = true, path = ARCHIVE_PATH } = {}) {
  if (!existsSync(path)) {
    if (!autoPull) throw new Error(`archive missing: ${path}`);
    console.log(`  archive not found locally — pulling from ${DRIVE_REMOTE}…`);
    pullFromDrive();
  }
  if (!existsSync(path)) {
    throw new Error(
      `No local archive and the Drive pull produced nothing.\n` +
      `  Check: rclone lsl "${DRIVE_REMOTE}"`
    );
  }
  const text = zlib.gunzipSync(readFileSync(path)).toString("utf8");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function rclone(args) {
  return execFileSync("rclone", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function pushToDrive() {
  if (!existsSync(ARCHIVE_PATH)) throw new Error(`nothing to push: ${ARCHIVE_PATH} missing`);
  rclone(["copy", ARCHIVE_PATH, DRIVE_REMOTE, "-v"]);
  // Verify the bytes actually landed rather than trusting the exit code.
  const listing = rclone(["lsjson", DRIVE_REMOTE]);
  const remote = JSON.parse(listing).find((f) => f.Name.endsWith(".jsonl.gz"));
  if (!remote) throw new Error("push reported success but Drive lists no archive");
  return remote;
}

export function pullFromDrive() {
  mkdirSync(dirname(ARCHIVE_PATH), { recursive: true });
  rclone(["copy", `${DRIVE_REMOTE}/${"wnba_historical_odds.jsonl.gz"}`, dirname(ARCHIVE_PATH), "-v"]);
}
