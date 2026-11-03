// Guard on the odds archive's dedup key and merge (untested until 2026-08-31).
//
// THE FAILURE THIS GUARDS. On 2026-08-31 an early puller upserted to Supabase
// before writing the raw cache. Books repeat a (player, market, side, line)
// tuple inside a single response, so batches died on "ON CONFLICT DO UPDATE
// cannot affect row a second time" — and because the cache write came after,
// ~5,700 credits of already-purchased data (137 games) was thrown away.
//
// `rowKey` is the survivor of that key. It is now the archive's ONLY notion of
// identity, and it has to match the dropped Postgres unique index exactly: if it
// is narrower, a re-pull collapses distinct quotes; if it is wider, a re-pull
// duplicates instead of replacing and the archive silently doubles. Neither is
// visible from the row count alone, because both produce "more rows than
// before" — which is what a successful pull also looks like.
//
// The archive is also pay-once and will not be repurchased (decision
// 2026-08-31), so a merge bug here is not recoverable by re-running anything.
import test from "node:test";
import assert from "node:assert/strict";
import { rowKey, mergeRows, ARCHIVE_PATH, DRIVE_REMOTE, readArchive } from "./odds-archive.mjs";

const q = (o = {}) => ({
  espn_game_id: "401736123", book: "fanduel", prop_type: "player_points",
  player_name: "A'ja Wilson", player_norm: "aja wilson", name: "Over",
  line: 22.5, odds: -115, game_date: "2026-08-12", ...o,
});

test("the dedup key separates every field the old unique index separated", () => {
  const base = q();
  for (const [field, other] of [
    ["espn_game_id", "401736124"],
    ["book", "draftkings"],
    ["prop_type", "player_rebounds"],
    ["player_name", "Kelsey Plum"],
    ["name", "Under"],
    ["line", 23.5],
  ]) {
    assert.notEqual(rowKey(base), rowKey(q({ [field]: other })),
      `${field} must be part of the identity — collapsing it loses a real quote`);
  }
});

test("the price is NOT part of the identity — a re-pull replaces, it does not append", () => {
  assert.equal(rowKey(q({ odds: -115 })), rowKey(q({ odds: +102 })),
    "same quote at a different price is the same row; keying on odds would double the archive");
});

test("a null line and an absent line are one key, not two", () => {
  // Some markets (a moneyline-shaped prop) carry no line at all. `line ?? ""`
  // makes null and undefined agree; if they did not, the same quote seen twice
  // would land as two rows.
  assert.equal(rowKey(q({ line: null })), rowKey(q({ line: undefined })));
});

test("a 0.5 line is distinct from a 0 line", () => {
  assert.notEqual(rowKey(q({ line: 0 })), rowKey(q({ line: 0.5 })));
});

test("mergeRows is last-write-wins on the key, so a re-pull refreshes prices", () => {
  const existing = [q({ odds: -115 }), q({ name: "Under", odds: -105 })];
  const incoming = [q({ odds: -130 })];
  const merged = mergeRows(existing, incoming);
  assert.equal(merged.length, 2, "the refreshed quote replaced rather than appended");
  const over = merged.find((r) => r.name === "Over");
  assert.equal(over.odds, -130, "the newer price won");
});

test("mergeRows collapses duplicates WITHIN one response — the batch that died", () => {
  // A single book response really does repeat the same tuple. This is the exact
  // shape that killed the Supabase upsert.
  const dupes = [q(), q(), q({ odds: -118 })];
  assert.equal(mergeRows([], dupes).length, 1);
});

test("merging an empty pull does not erase the archive", () => {
  const existing = [q(), q({ name: "Under" })];
  assert.equal(mergeRows(existing, []).length, 2);
});

test("readArchive refuses rather than silently returning nothing when told not to pull", () => {
  // The archive is gitignored, so a fresh checkout has no local copy. Every
  // consumer must either get the data or an error naming the Drive path — an
  // empty array here would be read downstream as "no odds exist".
  assert.throws(
    () => readArchive({ autoPull: false, path: "/nonexistent/wnba_historical_odds.jsonl.gz" }),
    /archive missing/,
  );
});

test("the archive's location is stated once, and is not a dated folder", () => {
  // The nightly Supabase backup writes gdrive:wnba-research-dashboard-backups/<date> — a
  // new folder every night. That is right for a rolling snapshot and wrong for a
  // pay-once artefact, which needs ONE stable path a fresh checkout can always
  // read. Pinning it here so the archive never drifts onto the dated scheme.
  assert.match(DRIVE_REMOTE, /^gdrive:wnba-research-dashboard-archive\/historical-odds$/);
  assert.doesNotMatch(DRIVE_REMOTE, /\d{4}-\d{2}-\d{2}/, "the archive path must not be dated");
  assert.match(ARCHIVE_PATH, /scripts\/out\/wnba_historical_odds\.jsonl\.gz$/);
});
