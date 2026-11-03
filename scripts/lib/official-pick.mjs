// ══════════════════════════════════════════════════════════════════════════
// isOfficialPick — the single place a WNBA projection becomes an OFFICIAL pick.
//
// ── WHY THIS FILE HAD TO BE INVENTED (2026-07-20) ──
//
// The handoff spec says: "Find wherever the WNBA cron decides a projection
// becomes a saved pick — the equivalent of isOfficialPick. Add an override
// consult there, and ONLY there."
//
// There was no such place. daily-predict.mjs saves EVERY projection for every
// projected player × every stat, unconditionally. Saving was not a decision, so
// there was no decision to gate. That left two options, and only one of them is
// safe:
//
//   ✗ Gate the WRITE — let a promoted override stop a row reaching wnba_picks.
//     This looks like the MLB shape but is actively destructive here, for two
//     compounding reasons:
//       (a) wnba_picks IS the lab's input. mlb-research-dashboard builds lab/wnba/feed.csv
//           straight off this table. Gating the write would delete the very rows
//           the analyst needs to keep validating — and worse, CHECK 5 ("is this
//           gate still retaining ≥15% of the market's recent picks?") would then
//           be measuring retention against a feed the gate itself had already
//           thinned. That is a self-confirming feedback loop: a gate tightens,
//           the feed shrinks to only what the gate passes, retention reads 100%,
//           and the gate looks healthy precisely as the market goes dark. It
//           would defeat the one check the handoff calls load-bearing.
//       (b) It violates the standing constraint outright — a gated market would
//           stop surfacing entirely, not just stop being official.
//
//   ✓ Gate a FLAG — every projection still saves, exactly as today, and carries
//     an `is_official` boolean. The board, the research feed, the lab's input
//     and the graded record are all untouched and complete. Only the official
//     designation is at stake. This is the true analog of MLB's isOfficialPick,
//     which likewise never removes a pick from the board — it only withholds
//     the 🎲.
//
// So: this function is consulted ONCE, in daily-predict.mjs, to stamp
// `is_official` on a row that is going to be written either way.
//
// ── THE BASE RULE IS DELIBERATELY `true` ──
//
// Today every saved projection is official; there is no pre-existing selection
// rule in this repo to preserve. Inventing selection criteria here would change
// live behavior beyond what the promotion gate is for, and would do it WITHOUT
// having gone through shadow — the exact thing this whole apparatus exists to
// prevent. So the base is an explicit, documented `true`, and the promoted
// override layer is the only thing that can ever subtract. When the lab later
// validates a genuine base rule, it ships the same way everything else does:
// ledger → clearance → shadow → override.
// ══════════════════════════════════════════════════════════════════════════

import { passesGateOverrides } from "./gate-overrides.mjs";

/**
 * Side-adjust a prediction row into the quantities the lab reasons about.
 *
 * This MIRRORS wnbaRow() in mlb-research-dashboard api/_sheets-feed.js. The lab's
 * prob_min/prob_max range over `prob_side`, NOT raw prob_over, and edge_min
 * ranges over `proj_edge`, NOT raw projection−line. Getting this wrong would
 * silently make a promoted gate bite differently from the gate the shadow slate
 * measured — a whole class of "the gate shipped but did something else" bug.
 */
export function sideAdjusted(row) {
  const over = row.side === "over";
  const probOver = row.prob_over != null ? Number(row.prob_over) : null;
  const proj = row.projection != null ? Number(row.projection) : null;
  const line = row.line != null ? Number(row.line) : null;
  return {
    prob: probOver == null ? null : over ? probOver : 1 - probOver,
    edge: proj == null || line == null ? null : over ? proj - line : line - proj,
    sigma: row.sigma != null ? Number(row.sigma) : null,
    gp: row.gp != null ? Number(row.gp) : null,
    // The side itself, passed through verbatim rather than folded into the
    // numbers above. `dir_filter` (enforceable since 2026-08-28) is categorical
    // — it selects a side rather than bounding a quantity — so it is the one
    // lever that needs the raw direction. lab-core `qualifies()` compares
    // against `r.dir`, which is this exact field in feed.csv, so a promoted
    // dir_filter bites here precisely as it scored in shadow.
    dir: row.side === "over" || row.side === "under" ? row.side : null,
  };
}

/**
 * Decide whether a prediction row is an OFFICIAL pick.
 *
 * The row is saved to wnba_picks regardless of what this returns — see the
 * header. This only stamps `is_official`.
 *
 * INVARIANT: the override consult is LAST and can only ever turn a true into a
 * false. Keep it that way. If a future base rule is added above, it must also
 * be able to reject independently, and the override must remain the final,
 * subtract-only word.
 */
export function isOfficialPick(row) {
  // ── base rule ──
  // Currently unconditional: every projection this model saves is official.
  // Documented and deliberate (see header). Any future base criteria go HERE,
  // above the override consult, never below it.
  let official = true;
  if (!official) return false;

  // ── promoted lab gates — LAST, and subtract-only ──
  return passesGateOverrides(row.stat, sideAdjusted(row));
}
