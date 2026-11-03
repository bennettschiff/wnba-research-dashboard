/**
 * Retrying fetch for Supabase/PostgREST calls.
 *
 * Why: the scheduled loop runs unattended, and PostgREST answers 503
 * `PGRST002 — Could not query the database for the schema cache. Retrying.`
 * for a few seconds whenever the schema cache reloads (Supabase restart or
 * maintenance). On 2026-08-25 that one-shot 503 killed the whole
 * `daily-predict` run — grading and the day's picks both skipped — for a
 * condition that clears on its own well inside a minute.
 *
 * Retries transient transport failures and retryable status codes with
 * exponential backoff. Any other response (including 4xx) is returned
 * untouched, so callers keep their own error text. If every attempt fails at
 * the transport layer, the last error is rethrown.
 */

// 503 covers PGRST002 and the gateway's own "database is starting" answer.
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// The backoff was 1/2/4/8 s — 15 seconds, sized for the PGRST002 schema-cache
// reload this helper was written for. That is not the only shape of outage the
// shared instance produces. On 2026-09-05 it stalled for ~8 MINUTES: PostgREST's
// own `SET client_encoding` hit the statement timeout and every request came back
// 504 after 135-180 s at the gateway. A 15-second backoff retries entirely inside
// something like that and then gives up with the database about to be fine.
//
// So: keep the fast early attempts (a schema-cache reload really does clear in
// seconds — no reason to make the common case slow) and add a long tail. Totals
// ~2.6 minutes, which covers the stalls this instance has actually produced.
export const DEFAULT_BACKOFF_MS = [1_000, 4_000, 15_000, 45_000, 90_000];

// Nothing here had a timeout, so a socket the server never closes could hold an
// unattended job open until the workflow's own timeout killed it — with no line
// in the log saying what it was waiting on.
export const DEFAULT_TIMEOUT_MS = 60_000;

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

export async function sbFetch(url, init = {}, {
  backoffMs = DEFAULT_BACKOFF_MS,
  attempts = backoffMs.length + 1,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  sleep = defaultSleep,
  onRetry = ({ attempt, delayMs, status, error }) =>
    console.warn(`  supabase retry ${attempt} in ${delayMs}ms (${status ?? error?.message ?? 'network error'})`),
} = {}) {
  let lastRes = null, lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastRes = null; lastErr = null;
    try {
      lastRes = await fetchImpl(url, {
        ...init,
        signal: init.signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined),
      });
      if (lastRes.ok || !RETRYABLE_STATUS.has(lastRes.status)) return lastRes;
    } catch (err) {
      lastErr = err;
      // A caller's own abort is a decision, not a transport failure — respect it.
      if (err?.name === 'AbortError' && init.signal?.aborted) throw err;
    }
    if (attempt === attempts) break;
    const delayMs = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1];
    onRetry?.({ attempt, delayMs, status: lastRes?.status ?? null, error: lastErr });
    await sleep(delayMs);
  }

  if (lastRes) return lastRes;   // let the caller report the final status/body
  throw lastErr;
}
