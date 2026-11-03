#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Retention for the nightly Drive backup folders.
//
//   node scripts/prune-backups.mjs               # DRY RUN — lists, deletes nothing
//   node scripts/prune-backups.mjs --apply       # actually delete
//   node scripts/prune-backups.mjs --check-gaps  # did a scheduled night go missing?
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// backup-to-drive.yml uploads to `gdrive:wnba-research-dashboard-backups/<date>` — a new
// dated folder every night, and nothing has ever removed one. That scheme is
// correct for a rolling snapshot of a live table (each night is a restorable
// point-in-time copy) and it is exactly wrong for a pay-once artefact, which is
// why the odds archive lives at a single stable path instead. But even for the
// rolling case it needs a ceiling: every folder holds a full dump of the same
// growing table, so the cost is quadratic in season length while the marginal
// value of the 60th consecutive daily copy is nil.
//
// ── THE POLICY ──────────────────────────────────────────────────────────────
//
// Keep the last KEEP_DAILY nightly folders, plus the first backup of every
// calendar month forever. That gives fine-grained recovery for the window where
// a mistake is still plausibly undiscovered, and a permanent monthly spine so a
// season can always be reconstructed at coarse resolution.
//
// ── DRY RUN IS THE DEFAULT, ON PURPOSE ──────────────────────────────────────
//
// These are the only offsite copies of wnba_picks. A retention bug that deletes
// the wrong set is unrecoverable, and this repo has already lost uncommitted
// work once to a routine that ran a destructive command without a human reading
// it first. So the workflow runs this in dry-run and prints the plan; deleting
// requires someone to dispatch it with prune=apply.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";

const REMOTE = "gdrive:wnba-research-dashboard-backups";
const KEEP_DAILY = 14;

const APPLY = process.argv.includes("--apply");
const CHECK_GAPS = process.argv.includes("--check-gaps");
const DATED = /^\d{4}-\d{2}-\d{2}$/;

function rclone(args) {
  return execFileSync("rclone", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

let listing;
try {
  listing = JSON.parse(rclone(["lsjson", REMOTE, "--dirs-only"]));
} catch (e) {
  console.error(`Could not list ${REMOTE}: ${e.message}`);
  console.error("If rclone is not configured here, run this from the backup workflow instead.");
  process.exit(1);
}

const folders = listing
  .map((f) => f.Name)
  .filter((n) => DATED.test(n))
  .sort();

if (!folders.length) {
  console.log(`No dated folders under ${REMOTE} — nothing to do.`);
  process.exit(0);
}

// ── gap detection ────────────────────────────────────────────────────────────
//
// THE FAILURE THIS CATCHES. 2026-08-19 has no backup folder. Nothing reported
// it, and nothing could have: the workflow self-alerts on FAILURE, and a
// scheduled run that GitHub drops never starts, so it never fails. A silently
// missing night is indistinguishable from a quiet one.
//
// Chaining the backup off another workflow does NOT fix this — every
// `workflow_run` chain in this repo has been removed or measured as
// non-functional (promotion-gate.yml dropped its chain off daily-predict on
// 2026-08-03 after an audit found it never once fired for a real scheduled
// upstream run; ops-alert delivers 11%). So the answer is redundancy on the
// schedule plus this check, which makes a drop visible after the fact.
//
// THE WINDOW IS THE ONE RETENTION PROMISES TO KEEP. Only the last KEEP_DAILY
// nights are guaranteed present; older absences are the prune doing its job, not
// a missed run. Checking the whole history instead reported all 49 folders this
// script had just legitimately deleted as "missed nights" — an alarm that fires
// on its own correct behaviour, which is worse than no alarm.
//
// Within that window a gap still only counts if a backup exists BEFORE it, so a
// leading run of absences reads as a deliberate stand-down (the lab is paused
// 08-31 → 09-15 with all three workflows disabled_manually) rather than an alert
// storm the morning the season restarts.
if (CHECK_GAPS) {
  const last = folders.at(-1);
  const windowStart = new Date(`${last}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - (KEEP_DAILY - 1));
  const inWindow = folders.filter((f) => f >= windowStart.toISOString().slice(0, 10));

  const gaps = [];
  let seenOne = false;
  for (let d = new Date(windowStart); d.toISOString().slice(0, 10) <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (inWindow.includes(iso)) { seenOne = true; continue; }
    if (seenOne) gaps.push(iso);   // interior only — see above
  }

  console.log(`${REMOTE}`);
  console.log(`  ${folders.length} dated folders · ${folders[0]} → ${last}`);
  console.log(`  checking the ${KEEP_DAILY}-night retained window (${windowStart.toISOString().slice(0, 10)} → ${last})`);
  if (!gaps.length) {
    console.log(`  no gaps — every night retention promises to keep is present.`);
    process.exit(0);
  }
  console.log(`\n  MISSED NIGHTS (inside the retained window, with a backup before them):`);
  for (const g of gaps) console.log(`    ${g}`);
  console.log(`\n  ${gaps.length} night${gaps.length === 1 ? "" : "s"} missing. A dropped scheduled run never starts, so it`);
  console.log(`  cannot fail, so the self-alert step could not have caught this at the time.`);
  console.log(`  Dispatching backup-to-drive.yml re-dumps the table AS IT IS NOW — the`);
  console.log(`  point-in-time copy for that night is gone and is not recoverable.`);
  process.exit(1);
}

// Keep: the newest KEEP_DAILY, plus the earliest folder in each calendar month.
const keep = new Set(folders.slice(-KEEP_DAILY));
const firstOfMonth = new Map();
for (const f of folders) {
  const ym = f.slice(0, 7);
  if (!firstOfMonth.has(ym)) firstOfMonth.set(ym, f);
}
for (const f of firstOfMonth.values()) keep.add(f);

const drop = folders.filter((f) => !keep.has(f));

console.log(`${REMOTE}`);
console.log(`  ${folders.length} dated folders · ${folders[0]} → ${folders.at(-1)}`);
console.log(`  policy: keep the last ${KEEP_DAILY} nightly + the first backup of every month`);
console.log(`  keeping ${keep.size} · removing ${drop.length}\n`);

if (drop.length) {
  console.log("  would remove:");
  for (const f of drop) console.log(`    ${f}`);
  console.log("");
  console.log("  monthly spine retained:");
  for (const [ym, f] of [...firstOfMonth].sort()) console.log(`    ${ym} → ${f}`);
  console.log("");
}

if (!APPLY) {
  console.log(drop.length
    ? `DRY RUN — nothing deleted. Re-run with --apply (or dispatch the workflow with prune=apply) to remove the ${drop.length} folders above.`
    : "Nothing to remove under the current policy.");
  process.exit(0);
}

// Refuse to run away. If the plan wants to delete most of the archive, something
// is wrong with the policy or the listing, not with the archive.
if (drop.length > folders.length - KEEP_DAILY) {
  console.error(`REFUSING: plan would remove ${drop.length} of ${folders.length} folders, more than the policy can justify.`);
  process.exit(1);
}

let removed = 0;
for (const f of drop) {
  rclone(["purge", `${REMOTE}/${f}`]);
  removed++;
  console.log(`  removed ${f}  (${removed}/${drop.length})`);
}
console.log(`\nDone. ${removed} folders removed, ${keep.size} retained.`);
