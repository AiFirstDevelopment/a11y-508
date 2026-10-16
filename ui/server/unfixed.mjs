// What the one screen says about a finding that could not be fixed: why, in plain words, from what
// the ledger recorded about it; the routes it was seen on; and the element.

// A page's route: the URL without its query (timestamped query variants are one route).
export function routeOf(u) {
  if (u === 'site') return u;
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}${x.hash}`;
  } catch {
    return u;
  }
}

export const routesOf = (entry) => [...new Set((entry.pages || []).map(routeOf))];

// The loop's own notes, in the person's words; anything else is the assistant's own note.
const NOTES = [
  [/^agent timed out$/, 'the assistant ran out of time'],
  [/^agent exit \d+, no result file$/, 'the assistant ended without saying what it did'],
];
function plainNote(note) {
  const n = String(note || '').trim().replace(/\.$/, '');
  if (!n) return '';
  for (const [re, words] of NOTES) if (re.test(n)) return words;
  return n;
}

const tries = (n) => (n === 1 ? 'one try' : `${n} tries`);

export function whyUnfixed(entry) {
  const attempts = entry.attempts || [];
  const last = attempts[attempts.length - 1];
  if (last) {
    const n = attempts.length;
    const note = plainNote(last.note);
    if (last.outcome === 'failed-gate') return `The fix broke the build or tests, so it was undone (${tries(n)}${last.gateReason ? `; ${plainNote(last.gateReason)}` : ''}).`;
    if (last.outcome === 'still-present') return `A fix was committed, but the problem was still there on the next crawl (${tries(n)}).`;
    if (last.outcome === 'no-change' || last.outcome === 'timed-out') return `The assistant made no change (${tries(n)})${note ? `: ${note}` : ''}.`;
    if (last.outcome === 'commit-failed') return `The fix could not be committed (${tries(n)})${note ? `: ${note}` : ''}.`;
  }
  const t = entry.triage;
  if (t && t.decision && !['adequate', 'inadequate'].includes(t.decision)) return `The assistant could not decide whether this is a problem${t.reason ? `: ${plainNote(t.reason)}` : ''}.`;
  if (entry.status === 'review') return 'A person has to judge this one: the checks cannot tell on their own, and it was not decided this time.';
  if (entry.reason) return `${plainNote(entry.reason).replace(/^[a-z]/, (c) => c.toUpperCase())}.`;
  return 'The loop ended before it got to this one.';
}

// The commits that fixed it (the last one is the fix that holds, or waits for the deployment).
export const fixesOf = (entry) => (entry.attempts || []).filter((a) => a && a.commit).map((a) => ({ round: a.round ?? null, commit: a.commit, files: a.files || [], note: a.note || null }));

export const unfixedFacts = (entry) => ({ routes: routesOf(entry), html: entry.html || '', why: whyUnfixed(entry), fixes: fixesOf(entry) });
