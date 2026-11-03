// ══════════════════════════════════════════════════════════════════════════
// Promoted lab gates (WNBA) — the bridge from lab/ledger.jsonl to live picks.
//
// WHY THIS EXISTS (2026-07-20). The WNBA lab loop in mlb-research-dashboard had filed 31
// proposals and forward-validated 12 of them, and shipped exactly zero. Not
// because the verdicts were bad — because the promotion gate lived in a repo
// that only READS wnba_picks. The analysis half of the loop ran there; the
// shipping half had to be built here, where the predictor actually lives.
//
// ── THE WNBA-SPECIFIC SHAPE OF THIS LAYER ──
//
// This is NOT a straight copy of the MLB gateOverrides.js. Three real
// differences, each load-bearing:
//
//   1. PROB SPACE IS ENFORCEABLE HERE, MLB'S IS NOT. On MLB, a prob-space gate
//      is refused outright at the file level. On WNBA it cannot be — 9 of the
//      12 validated proposals are prob_min/prob_max gates, and refusing them
//      all would mean the loop still ships nothing. So prob-space is allowed,
//      but ONLY with a validated score-space (edge_min) twin on the same
//      market, enforced at clearance time by promotion-gate.mjs CHECK 3.
//
//      The danger is real and worth restating: WNBA `prob_side` comes out of a
//      projection-plus-sigma normal model, so ANY change to the projection or
//      to SIGMA_COEFF/SIGMA_FLOOR silently retunes every prob-space gate at
//      once. A gate written `prob >= 0.58` tightens without anyone touching it
//      and the market quietly goes dark. That is exactly the MLB HRR 0-pick
//      drought. The edge_min twin is the tripwire: it is score-space, so it
//      does not move when the calibration does, and it keeps a floor of picks
//      flowing if the prob gate drifts shut.
//
//   2. GLOBALS ARE ENFORCEABLE HERE, MLB'S ARE NOT. The MLB gate blocks every
//      global lever as "no analog in picks.js" — odds_min, ev_min_pct etc.
//      describe the workbook's filtering of an already-saved pick set. WNBA's
//      two globals are different in kind: `sigma_max` and `gp_min` range over
//      `sigma` and `gp`, which the predictor computes for every row before it
//      writes it. They have a genuine live analog, so they are gateable rather
//      than advisory. (This matters: the validated global sigma_max = 3.5
//      volatility gate, +5.45u, is promotable rather than a dead letter.)
//
//   3. IT GATES A FLAG, NOT A WRITE. See official-pick.mjs — the predictor
//      saves every projection unconditionally and always will.
//
// ── HARD RULES ──
//
//   A. OVERRIDES SUBTRACT, NEVER ADD. Consulted last in isOfficialPick, and
//      every code path here either returns true (no opinion) or false. A bad
//      graduation must not be able to widen the pick set.
//
//   B. A MARKET NEVER STOPS SURFACING. This layer cannot remove a row from
//      wnba_picks, and `include = 0` is refused outright by the gate. CHECK 5
//      additionally refuses any gate that would starve a market's flow.
//
//   C. GENERATED, NOT AUTHORED. promotion-gate.mjs writes the JSON. Hand-edits
//      get clobbered. To remove a gate, run `--revert` so the removal lands in
//      docs/GATE_CHANGELOG.md with a reason.
// ══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OVERRIDES_PATH = path.join(HERE, "gate-overrides.json");

// Read at import. Node has no JSON-import-assertion stability across versions
// worth depending on here, and the file is tiny.
function load() {
  try { return JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8")); }
  catch { return { globals: {}, markets: {} }; }
}

let OVERRIDES = load();

// Test seam ONLY. promotion-gate.mjs writes the file and exits; nothing in the
// predictor path calls this. Exists so the invariant suite can exercise the
// enforcement logic against a fake promoted gate without touching the artifact
// — the check that caught the MLB deadlock.
export function __setOverridesForTest(o) { OVERRIDES = o ?? { globals: {}, markets: {} }; }
export function __reloadOverrides() { OVERRIDES = load(); }

// Params this layer knows how to enforce. Anything else in the JSON is data for
// the changelog/report and is deliberately inert at runtime — a config key the
// lab can express but the predictor cannot honor must NOT silently do nothing
// under a name that looks like it works.
// `dir_filter` joined this set on 2026-08-28. It is the first CATEGORICAL lever
// here — every other param is a numeric threshold — and that distinction is
// load-bearing in two places downstream, so it is worth stating plainly:
//
//   - It cannot silently retune. CHECK 3 in promotion-gate.mjs demands a
//     score-space twin for prob-space gates because prob_side moves whenever the
//     projection or sigma moves. A direction is a direction; no calibration
//     change can slide it. So CHECK 3 keys on prob-space explicitly now rather
//     than on "not score-space", which had been treating every non-score param
//     as prob-space by assumption.
//   - It has no sign. Number("under") is NaN and NaN !== NaN, so the numeric
//     opposite-sign/cluster comparisons in CHECK 4 would have read every pair of
//     categorical proposals as a conflict and every cluster as empty.
//
// Why it exists: on v4 the under side returns ~12x the ROI per pick of the over
// side, and two markets carry outright negative over books (ast/over 51.1%,
// -8.7u; sb/over 47.6%, -13.4u). Direction was the largest unexploited pattern
// in the 2026-08-27 audit and the only lever there addressing structure rather
// than a threshold.
export const ENFORCEABLE_MARKET = new Set(["prob_min", "prob_max", "edge_min", "dir_filter"]);
export const ENFORCEABLE_GLOBAL = new Set(["sigma_max", "gp_min"]);

export function getGateOverride(market) {
  return OVERRIDES?.markets?.[market] ?? null;
}

export function getGlobalOverrides() {
  const g = OVERRIDES?.globals ?? {};
  return Object.fromEntries(Object.entries(g).filter(([k]) => ENFORCEABLE_GLOBAL.has(k)));
}

/**
 * True if this pick clears the promoted lab gates.
 *
 * @param market  one of ast|fg3m|pra|pts|reb|sb
 * @param v       { prob, edge, sigma, gp, dir } — the row's SIDE-ADJUSTED values.
 *                `prob` is prob_side (over → prob_over, under → 1−prob_over) and
 *                `edge` is proj_edge (over → proj−line, under → line−proj), the
 *                exact quantities the lab's prob_min/prob_max/edge_min range
 *                over in api/_sheets-feed.js. Passing raw prob_over here would
 *                make a promoted gate mean something different from what the
 *                shadow slate measured — see official-pick.mjs.
 *
 * Bounds are INCLUSIVE-SAFE: they mirror lab-core `qualifies()` exactly
 * (`prob < prob_min || prob > prob_max` → reject), so a pick sitting on a
 * promoted bound survives here iff it survived in the shadow scoring.
 */
export function passesGateOverrides(market, v = {}) {
  const { prob = null, edge = null, sigma = null, gp = null, dir = null } = v;

  // Globals first — they are market-agnostic.
  const g = OVERRIDES?.globals ?? {};
  if (g.sigma_max?.value != null && sigma != null && sigma > g.sigma_max.value) return false;
  if (g.gp_min?.value != null && gp != null && gp < g.gp_min.value) return false;

  const o = getGateOverride(market);
  if (!o) return true;
  if (prob != null) {
    if (o.prob_min != null && prob < o.prob_min) return false;
    if (o.prob_max != null && prob > o.prob_max) return false;
  }
  if (edge != null) {
    if (o.edge_min != null && edge < o.edge_min) return false;
  }
  // Direction — categorical, not a threshold. `dir_filter` names the ONE side
  // that stays official for this market; the other side still saves, still
  // grades, and still reaches lab/feed.csv, it just loses the badge (Rule B).
  // null / "all" is no opinion, mirroring lab-core `qualifies()` exactly.
  //
  // Fails OPEN on a missing dir, like every other param here. That is Rule A:
  // a code path that cannot see its input returns "no opinion" rather than
  // subtracting. Fail-closed would silently un-official an entire market the
  // day `side` ever stopped being passed — a far worse failure than a gate that
  // is briefly inert, and one that would look exactly like a market going dark.
  if (dir != null && o.dir_filter != null && o.dir_filter !== "all" && dir !== o.dir_filter) {
    return false;
  }
  return true;
}

// Introspection for the report + tests: which markets/globals currently carry a
// promoted gate, and what does each one do. Surfaced so a gated-out pick can
// explain itself rather than just quietly losing its badge.
export function activeOverrides() {
  const out = [];
  for (const [market, o] of Object.entries(OVERRIDES?.markets ?? {})) {
    const params = Object.entries(o).filter(([k]) => ENFORCEABLE_MARKET.has(k));
    if (params.length) out.push({ market, params: Object.fromEntries(params), meta: o });
  }
  return out;
}

export function activeGlobals() {
  return Object.entries(getGlobalOverrides())
    .filter(([, o]) => o?.value != null)
    .map(([key, o]) => ({ key, value: o.value, meta: o }));
}

export const overridesVersion = () => OVERRIDES?.version ?? null;

// The promoted gates as a PARTIAL lab config — `{ markets: { ast: { prob_min } },
// sigma_max }` — so lab-analyst.mjs can deep-merge it over the sheet defaults
// and score against what the board actually runs. Only enforceable params make
// it in, for the same reason as above: a key the predictor cannot honor is not
// part of the live incumbent. Globals unwrap their `{ value }` envelope into
// the lab's scalar shape.
export function liveGatePartial() {
  return gatePartialFrom(OVERRIDES);
}

// Same projection from an overrides OBJECT rather than the module's copy.
// promotion-gate.mjs holds its own in-memory overrides and writes promotions
// into it mid-run, so it must build the incumbent from that object, not from
// whatever this module read off disk at import.
export function gatePartialFrom(o) {
  const out = {};
  for (const [market, params] of Object.entries(o?.markets ?? {})) {
    const p = Object.entries(params ?? {}).filter(([k, v]) => ENFORCEABLE_MARKET.has(k) && v != null);
    if (p.length) (out.markets ??= {})[market] = Object.fromEntries(p);
  }
  for (const [key, g] of Object.entries(o?.globals ?? {})) {
    if (ENFORCEABLE_GLOBAL.has(key) && g?.value != null) out[key] = g.value;
  }
  return out;
}
