// The manual flow on the dashboard (docs/plans/manual-findings.md): the state of a run of kind
// "manual", built from its "manual" and "manual-decision" events.

export interface ManualComponent {
  name: string;
  file: string | null;
  selector?: string | null;
  unlisted?: boolean;
}

export interface PlanItem {
  finding: string;
  title: string;
  page: number;
  quote: string;
  url: string;
  fix: string;
  component: ManualComponent | null;
  files: string[];
  decisions: { decision: string; reason: string }[];
  confirm: { understood: boolean; text: string } | null;
  screenshot: string | null;
  // From the parse (docs/plans/pdf-parse.md): every PDF page about it, the tester's status, the
  // picture of its first page (under parsed/), and "Came back: ..." when the tester had verified it fixed.
  pages?: number[];
  status?: 'fixed' | 'open' | null;
  picture?: string | null;
  cameBack?: string | null;
  // docs/plans/read-from-parse.md: what the assistant said the page shows (AC 6), and, when the tool
  // could not find the element on the deployed page, the line that says so (AC 4).
  seen?: string | null;
  located?: boolean | null;
  notLocated?: string | null;
}

export interface AlreadyFixedRow {
  finding: string;
  title: string;
  quote: string;
  page: number;
  url: string;
  checkedAt: string;
  reason: string;
  screenshot: string | null;
  pages?: number[];
  picture?: string | null;
  // "The tester verified this fixed on 28 Sep 2026; the deployed site agrees." when they had.
  tester?: string | null;
  seen?: string | null;
  notLocated?: string | null;
}

export interface ManualDecision {
  at: string;
  stage: string;
  finding: string | null;
  by: string;
  decision: string;
  reason: string;
  evidence?: string;
}

// One finding of a PDF run as GET /api/manual/:id/decisions groups it (decisions.md's sections).
export interface DecisionGroup {
  finding: string;
  title: string;
  page: number;
  quote: string;
  url?: string | null;
  status: string | null;
  decisions: ManualDecision[];
  commits: { sha: string; short: string; files: string[]; url: string | null }[];
  screenshots: { label: string; path: string }[];
  picture?: string | null;
  seen?: string | null;
}

// "What the assistant saw on page 12: ..." (docs/plans/read-from-parse.md AC 6).
export const seenWords = (r: { page: number; seen?: string | null }) => (r.seen ? `What the assistant saw on page ${r.page}: ${r.seen}` : 'The assistant did not describe this page.');

export interface ManualState {
  id: string | null;
  // The latest stage event's stage, and the event itself.
  stage: string | null;
  last: Record<string, any> | null;
  findings: number | null;
  alreadyFixed: AlreadyFixedRow[];
  allGone: boolean;
  plan: { version: number; reason: string; notHeld: number; items: PlanItem[] } | null;
  // Waiting for the developer: the plan is shown with its edit controls.
  reviewing: boolean;
  approveRefused: string[];
  verdicts: { finding: string; verdict: string; reason: string; label: string }[];
  decisions: ManualDecision[];
  noFindings: string | null;
  readFailed: string | null;
  // The parse (docs/plans/pdf-parse.md): its first count while it runs, its facts once done, or why
  // the PDF could not be opened.
  parse: { pages: number; withPictures: number } | null;
  parsed: { pages: number; withText: number; withPictures: number; notes: string[] } | null;
  parseFailed: string | null;
  noText: boolean;
  // The assistant that could not read it, by name.
  readFailedBy: string | null;
  // The read's first answer had no list of findings: why, while it is asked again.
  readAgain: string | null;
  // The tool's list from the parse (docs/plans/read-from-parse.md AC 1): how many findings on how many pages.
  candidates: { findings: number; pages: number } | null;
  done: { message: string; fixed: number; alreadyFixed: number; all: boolean } | null;
  commits: number;
  fix: { n: number; m: number; finding: string; title: string; attempt: number } | null;
  capture: { n: number; m: number; label: string } | null;
  deployCheck: Record<string, any> | null;
  // The wait for the deployment of the latest push: how many fixes, on which branch.
  deployWait: Record<string, any> | null;
}

export const emptyManual = (): ManualState => ({
  id: null, stage: null, last: null, findings: null, alreadyFixed: [], allGone: false, plan: null, reviewing: false, approveRefused: [], verdicts: [], decisions: [],
  noFindings: null, readFailed: null, readFailedBy: null, parse: null, parsed: null, parseFailed: null, noText: false, readAgain: null, candidates: null, done: null, commits: 0, fix: null, capture: null, deployCheck: null, deployWait: null,
});

// The state after one more event.
export function applyManual(s: ManualState, ev: Record<string, any>): ManualState {
  if (ev['type'] === 'manual-decision') return { ...s, decisions: [...s.decisions, ev as unknown as ManualDecision] };
  const st = String(ev['stage'] || '');
  const n: ManualState = { ...s, stage: st === 'agent' || st === 'decision' ? s.stage : st, last: st === 'agent' ? s.last : ev };
  switch (st) {
    case 'start':
      n.id = ev['id'] || null;
      break;
    case 'findings':
      n.findings = Number(ev['count']) || 0;
      break;
    case 'no-findings':
      n.noFindings = String(ev['message'] || '');
      break;
    case 'parse':
      if (ev['pages'] !== undefined) n.parse = { pages: Number(ev['pages']) || 0, withPictures: Number(ev['withPictures']) || 0 };
      break;
    case 'parsed':
      n.parsed = { pages: Number(ev['pages']) || 0, withText: Number(ev['withText']) || 0, withPictures: Number(ev['withPictures']) || 0, notes: ev['notes'] || [] };
      n.noText = !!n.parsed.pages && !n.parsed.withText;
      break;
    case 'parse-failed':
      n.parseFailed = String(ev['reason'] || '');
      break;
    case 'read':
      if (ev['noText'] !== undefined) n.noText = !!ev['noText'];
      if (ev['candidates'] !== undefined) n.candidates = { findings: Number(ev['candidates']) || 0, pages: Number(ev['pages']) || 0 };
      break;
    case 'read-again':
      n.readAgain = String(ev['reason'] || '');
      break;
    case 'read-failed':
      n.readFailed = String(ev['reason'] || '');
      n.readFailedBy = ev['assistant'] ? String(ev['assistant']) : null;
      break;
    case 'capture':
      n.capture = { n: ev['n'], m: ev['m'], label: ev['label'] };
      break;
    case 'already-fixed':
      n.alreadyFixed = ev['rows'] || [];
      n.allGone = !!ev['all'];
      break;
    case 'plan':
      n.plan = { version: ev['version'], reason: ev['reason'], notHeld: Number(ev['notHeld']) || 0, items: ev['items'] || [] };
      n.approveRefused = [];
      break;
    case 'review':
      n.reviewing = true;
      break;
    case 'confirming':
      n.reviewing = false;
      break;
    case 'approve-refused':
      n.approveRefused = ev['findings'] || [];
      break;
    case 'approved':
      n.reviewing = false;
      break;
    case 'fix':
      n.reviewing = false;
      n.fix = { n: ev['n'], m: ev['m'], finding: ev['finding'], title: ev['title'], attempt: ev['attempt'] };
      break;
    case 'commit':
      n.commits = s.commits + 1;
      break;
    case 'await-deploy':
      n.deployWait = ev;
      n.deployCheck = null;
      break;
    case 'deploy-check':
      n.deployCheck = ev;
      break;
    case 'verdicts':
      n.verdicts = [...s.verdicts.filter((v) => !(ev['items'] || []).some((x: any) => x.finding === v.finding)), ...(ev['items'] || [])];
      break;
    case 'done':
      n.done = { message: String(ev['message'] || ''), fixed: Number(ev['fixed']) || 0, alreadyFixed: Number(ev['alreadyFixed']) || 0, all: !!ev['all'] };
      n.reviewing = false;
      break;
  }
  return n;
}

// The path of one of the run's files, as the server serves it (a link or an <img> sends the cookie).
export const manualFileUrl = (id: string | null, rel: string) => (id ? `/api/manual/${encodeURIComponent(id)}/file/${rel.split('/').map(encodeURIComponent).join('/')}` : '');
export const pdfPageUrl = (id: string | null, page: number) => `${manualFileUrl(id, 'source.pdf')}#page=${page}`;
// One file of the run's parse: report.md, manifest.json or pages/<name>.png.
export const parsedFileUrl = (id: string | null, rel: string) => (id ? `/api/manual/${encodeURIComponent(id)}/parsed/${rel.split('/').map(encodeURIComponent).join('/')}` : '');
