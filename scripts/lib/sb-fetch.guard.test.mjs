/**
 * The guard that keeps every scheduled script on scripts/lib/sb-fetch.mjs.
 *
 * WHY. On 2026-09-05 the shared Supabase instance stalled for ~8 minutes and
 * jobs in two other repos died inside it, each reporting the outage in its own
 * vocabulary so it read like two unrelated regressions. The mechanism was not
 * the stall — it was that every script had hand-rolled its own idea of what a
 * failed request means, so a fix lands in one copy and the next outage arrives
 * through another. This repo mostly avoided that by having sb-fetch.mjs from the
 * start, but shadow-pricing.mjs had drifted back to a bare fetch and nothing
 * would have noticed until it cost a run.
 *
 * A fix you have to remember to apply is not a fix. This reads .github/workflows,
 * resolves the scripts they run, and fails if one reaches /rest/v1/ directly.
 *
 * If a script legitimately needs a raw fetch, add it to ALLOWED with a reason.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WF_DIR = path.join(ROOT, '.github/workflows');

/** file → why it is allowed to call fetch() against Supabase directly. */
const ALLOWED = new Map();

const WINDOW = 400;

/** Strip comments so a line that only LOOKS like code doesn't count as code. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The text of fetch()'s first argument — the URL expression. */
function firstArg(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if ('([{`'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (--depth === 0) return code.slice(openIdx + 1, i); }
    else if (c === ',' && depth === 1) return code.slice(openIdx + 1, i);
  }
  return code.slice(openIdx, openIdx + WINDOW);
}

function bareSupabaseFetches(code) {
  const hits = [];
  // `\bfetch(` and not `sbFetch(` — the helper itself is the thing we want.
  for (const m of code.matchAll(/(^|[^\w.])fetch\s*\(/g)) {
    const idx = m.index + m[0].length - 'fetch('.length;
    const open = m.index + m[0].length - 1;
    const arg = firstArg(code, open);
    // An absolute URL that is not a PostgREST path is some other API (stats
    // feeds, the odds API). Those legitimately use plain fetch.
    if (/https?:\/\//.test(arg) && !/rest\/v1/.test(arg)) continue;
    let isSupabase = /rest\/v1/.test(arg);
    const ident = arg.trim().match(/^[A-Za-z_$][\w$]*$/)?.[0];
    if (!isSupabase && ident) {
      const before = code.slice(Math.max(0, idx - WINDOW), idx);
      isSupabase = new RegExp(`\\b${ident}\\s*=[^;]*rest\\/v1`).test(before);
    }
    if (isSupabase) hits.push(code.slice(0, idx).split('\n').length);
  }
  return hits;
}

function workflowScripts() {
  const found = new Set();
  for (const f of fs.readdirSync(WF_DIR).filter(f => /\.ya?ml$/.test(f))) {
    const text = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
    for (const m of text.matchAll(/scripts\/[A-Za-z0-9._-]+\.mjs/g)) found.add(m[0]);
  }
  return [...found].filter(rel => fs.existsSync(path.join(ROOT, rel))).sort();
}

const SCRIPTS = workflowScripts();

test('the guard actually found the scheduled scripts', () => {
  assert.ok(SCRIPTS.length >= 2, `only found ${SCRIPTS.length} workflow-referenced scripts`);
});

for (const rel of SCRIPTS) {
  const reason = ALLOWED.get(rel);
  test(`${rel} routes Supabase through sb-fetch.mjs${reason ? ' (allowed)' : ''}`, () => {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const hits = bareSupabaseFetches(code);
    if (reason) {
      // An allowlisted file must still be doing the thing it was excused for,
      // or the exemption outlives its reason and quietly re-opens a hole.
      assert.ok(hits.length > 0, `${rel} is allowlisted but has no raw Supabase fetch — remove it from ALLOWED`);
      return;
    }
    assert.deepEqual(hits, [],
      `${rel} calls fetch() against Supabase directly (line${hits.length > 1 ? 's' : ''} ${hits.join(', ')}). ` +
      'Use sbFetch from scripts/lib/sb-fetch.mjs so it survives a stall like 2026-09-05, ' +
      'or add it to ALLOWED in this file with the reason it must be raw.');
  });

  test(`${rel} imports sb-fetch where it uses it`, () => {
    // An import inserted inside a block comment parses fine and dies at runtime.
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    if (!/\bsbFetch\s*\(/.test(code)) return;
    assert.ok(/import\s*\{[^}]*sbFetch[^}]*\}\s*from\s*['"][^'"]*sb-fetch\.mjs['"]/.test(code),
      `${rel} uses sbFetch but has no live import of it`);
  });
}
