// How a run ended, in a person's words: one plain sentence for the headline, the raw text kept
// for a collapsed Details. Shared by the Fix step, the Crawl step and "Where you are".

// The crawl's sign-in waited and gave up, or the crawler could not get in.
const SIGN_IN = /gave up after .* waiting for sign-in|sign-in was stopped before|sign-in did not finish|could not get into the app|login failed/i;

export function signInFailed(texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => !!t && SIGN_IN.test(t));
}

// Wrappers the CLI puts in front of the real reason ("crawl failed: …", "error …").
const WRAPPERS = /^(the run failed|crawl failed|error|warn|fatal)$/i;

// The error's first meaningful clause, as a plain sentence: "crawl failed: the crawl produced no
// report (exit 2): …" reads "The site could not be checked: the crawl produced no report."
export function plainReason(message: string | null | undefined): string {
  const text = String(message || '')
    .replace(/^The run failed:\s*/i, '')
    .replace(/\s*\(exit code \d+\)\.?$/i, '')
    .trim();
  const clauses = text.split(/[:;\n]/).map((c) => c.replace(/\(exit (code )?\d+\)/gi, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const crawl = /^crawl failed$/i.test(clauses[0] || '');
  const clause = clauses.find((c) => !WRAPPERS.test(c)) || '';
  const lead = crawl ? 'The site could not be checked' : '';
  if (!clause) return lead ? `${lead}.` : 'Something went wrong.';
  const body = clause.replace(/\.$/, '');
  return lead ? `${lead}: ${body.charAt(0).toLowerCase()}${body.slice(1)}.` : `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
}

export const SIGN_IN_HEADLINE = 'Nobody signed in, so the site was not checked.';
