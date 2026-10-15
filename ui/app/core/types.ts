// Shapes the server sends. Loose where the core's report is large.

export type Impact = 'critical' | 'serious' | 'moderate' | 'minor';
export const IMPACTS: Impact[] = ['critical', 'serious', 'moderate', 'minor'];
export type ByImpact = Record<Impact, number>;

export interface Preset {
  name: string;
  label: string;
  bin: string;
  found: boolean;
  path: string | null;
  where: string | null;
  version: string | null;
  command: string;
  install: string;
  // What a person can paste into their shell to run it by hand (null when not installed).
  runCommand?: string | null;
}

// GET /api/loop/defaults: what the Fix loop infers from the working directory.
export interface LoopDefaults {
  repo: { git: boolean; remote: string | null; branch: string | null };
  package: { exists: boolean; build: string | null; test: string | null; testHint?: string };
  source: string[];
  suggested: Record<string, any>;
  effective: { source: string[]; check: string | null; branch: string; push: boolean; deployed: string; deployTimeout: number; maxAttempts: number };
  // The configured branch and the one the loop will commit on for it (an a11y-508/* branch in the way).
  branch?: { wanted: string; used: string; reason: string | null };
  configExists: boolean;
}

// GET /api/loop/match: whether the folders the loop edits hold the latest report's markup.
export interface LoopMatch {
  report: boolean;
  source: string[];
  checked: number;
  found: number;
  examples: { token: string; kind: string; file: string }[];
}

export interface Remedy {
  id: string;
  text: string;
  command: string | null;
}

export interface AgentTest {
  agent: string;
  command: string;
  status: 'ready' | 'failed' | 'timed-out';
  code: number | null;
  durationMs: number;
  output: string[];
}

export interface RunInfo {
  id: string;
  kind: string;
  // interrupted: a fix loop whose process is gone without finishing (the dashboard was closed).
  status: 'running' | 'done' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  code: number | null;
  meta: Record<string, unknown>;
  // The try again the server scheduled after it (a fix loop that could not start, failed, or ended
  // waiting for a deployment): when, which attempt, why; cancelled by Stop, firedAt once started.
  retry?: RetryInfo | null;
}

export interface RetryInfo {
  attempt: number;
  at: string;
  reason: string;
  kind: 'precondition' | 'error' | 'wait';
  cancelled?: boolean;
  firedAt?: string;
}

// What a folder holds, as the picker's badges show it.
export interface DirFacts {
  git: boolean;
  config: boolean;
  report: boolean;
  ledger: boolean;
  session: boolean;
  package?: boolean;
}
export const FACTS: (keyof DirFacts)[] = ['git', 'config', 'report', 'ledger', 'session'];

export interface DirEntry {
  name: string;
  path: string;
  hidden: boolean;
  facts: DirFacts;
}

// GET /api/dirs: the roots (path null), or one directory's subdirectories.
export interface DirListing {
  roots: boolean;
  path: string | null;
  parent: string | null;
  crumbs: { name: string; path: string }[];
  facts: DirFacts | null;
  dirs: DirEntry[];
}

export interface EnvInfo {
  cwd: string;
  cwdFacts: DirFacts;
  inGitRepo: boolean;
  launchDir: string;
  version: string;
  // The code this dashboard runs: the tool's git commit, else its version.
  revision?: string;
  platform: string;
  browser: { found: boolean; path: string | null; error?: string };
  config: { exists: boolean; file: string; repository?: boolean };
  // The dashboard's own directory for this working directory, and files it may have left in it before.
  stateDir?: string;
  pastRuns?: number;
  // Where a sign-in opens: a tab in the dashboard's own window, or a window of its own.
  signIn?: 'tab' | 'window' | 'separate-window';
  legacy?: string[];
  session: { exists: boolean; file: string; ageMs?: number; capturedAt?: string | null; origins?: string[] };
  report: { exists: boolean; finishedAt?: string; baseUrl?: string; pages?: number | null; violations?: number | null; reviews?: number | null };
  tokenInEnv: boolean;
  tokenHeld: boolean;
  // Null while the assistants are still being detected (detecting: true).
  shell: { name: string; path: string; kind: string } | null;
  npmPrefix: string | null;
  presets: Preset[] | null;
  detecting?: boolean;
  // The folder and URL remembered server-side (~/.a11y-508/settings.json); restored: the server
  // started in the remembered folder.
  last?: { cwd: string | null; url: string | null };
  restored?: boolean;
  lastTest: Record<string, AgentTest>;
  build: { fresh: boolean | null; reason: string | null };
  run: RunInfo | null;
  // The wizard step the person was on (settings.json), where the dashboard opens next time.
  lastStep?: string | null;
}

// Every event carries type and seq (from the server); the rest varies.
export interface RunEvent {
  type: string;
  seq: number;
  at?: string;
  [k: string]: any;
}

export interface Finding {
  test: string;
  name: string;
  wcag: string;
  level: 'violation' | 'review';
  impact: Impact;
  message: string;
  selector?: string;
  html?: string;
  state?: string;
  // The same-origin frame the element is in (its selector, " >>> " between nested frames).
  frame?: string;
  details?: unknown;
  page?: string;
  pages?: string[];
  beyond508?: boolean;
}

export interface ReportPage {
  url: string;
  finalUrl?: string;
  title?: string;
  status?: number;
  error?: string | null;
  skipped?: string | null;
  findings: Finding[];
  durationMs?: number;
  servedWith?: number | null;
  info?: { links?: string[] } | null;
  discovery?: { clicked?: number; urls?: string[]; skipped?: { name?: string; selector?: string }[]; skippedCount?: number; capped?: number } | null;
}

export interface Report {
  id: string;
  baseUrl: string;
  finishedAt: string;
  passed: boolean;
  options: { failOn: string[]; wcag?: string };
  summary: {
    pages: number;
    audited: number;
    failed: number;
    skipped: number;
    violations: number;
    reviews: number;
    byImpact: ByImpact;
    byTest: Record<string, { violations: number; reviews: number }>;
    coverage?: { complete: boolean; warnings: string[]; notes: string[] };
  };
  site: { findings: Finding[] };
  manual: { test: string; name: string; wcag: string; automation: string; condition: string; note?: string }[];
  pages: ReportPage[];
  catalog: Record<string, { name: string; wcag: string; condition: string; automation: string; level?: string; beyond508?: boolean }>;
}

export interface ReportListEntry {
  id: string;
  source: 'latest' | 'history' | 'round';
  round?: number;
  finishedAt: string | null;
  baseUrl: string | null;
  passed: boolean;
  result: string;
  summary: { pages: number; audited: number; violations: number; reviews: number; byImpact: ByImpact; coverageComplete: boolean };
}

export interface LedgerItem {
  test: string;
  impact: string;
  message: string;
  pages: number;
  attempts: number;
  reason: string | null;
  selector: string;
}

export interface LedgerInfo {
  exists: boolean;
  rounds?: { round: number; at: string; pages: number; audited: number; violations: number; reviews: number; diff: Record<string, number> }[];
  counts?: Record<string, number>;
  line?: string;
  lists?: Record<string, LedgerItem[]>;
  // Fixes committed and waiting for a deployment (the loop's ledger.deploy).
  deploy?: { round: number; branch: string; remote: string | null; pushed: boolean; host: string; since: string; pushedAt?: string | null } | null;
}

// GET /api/loop/timeline: the fix loop's rounds from the ledger, as History and "Where you are" show them.
export interface TimelineRound {
  round: number;
  at: string | null;
  found: number;
  fixed: number;
  commits: number;
  covered?: number;
  remaining: number;
  verified?: number;
  source?: 'crawl' | 'report' | 'ledger';
  pages?: number | null;
  audited?: number | null;
  reviews?: number | null;
  failed?: number;
  branch?: string | null;
  pushed?: boolean;
  remote?: string | null;
  state?: 'awaiting-deploy' | 'done';
  label?: string | null;
  changes?: any[];
}
// The whole run so far in a few numbers (GET /api/loop/timeline, total.tally).
export interface Tally {
  rounds: number;
  startedAt: string | null;
  lastAt: string | null;
  found: number;
  verified: number;
  pending: number;
  open: number;
  skipped: number;
  adequate: number;
  gone: number;
  review: number;
  commits: number;
  calls: number;
  agentMs: number;
  didNotHold: number;
  verifiedTotal: number;
  branch: string | null;
}

export interface LoopTimeline {
  rounds: TimelineRound[];
  deploy?: LedgerInfo['deploy'];
  total: { rounds: number; fixed: number; pending?: number; of: number; remaining: number; tally?: Tally };
}

// GET /api/loop/routes: every route audited across the rounds, and the latest crawl's coverage.
export interface RouteRow {
  url: string;
  path: string;
  title: string | null;
  rounds: number[];
  audited: number;
  errors: number;
  skipped: number;
  status: string | null;
  violations: number;
  reviews: number;
  found: { links: number; clicked: number | null; clickedNew: number | null; searched?: number | null; searchResults?: number | null; skippedActions: string[]; skippedActionsCount: number } | null;
  foundBy: string | null;
  lastAt: string | null;
}
export interface CrawledRoutes {
  routes: RouteRow[];
  rounds: number;
  discovered: number;
  coverage: { complete: boolean; warnings: string[]; notes: string[] };
}
