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
  package: { exists: boolean; build: string | null; test: string | null };
  source: string[];
  suggested: Record<string, any>;
  effective: { source: string[]; check: string | null; branch: string; push: boolean; deployed: string; deployTimeout: number; maxAttempts: number };
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
  status: 'running' | 'done';
  startedAt: string;
  finishedAt: string | null;
  code: number | null;
  meta: Record<string, unknown>;
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
  report: { exists: boolean; finishedAt?: string; baseUrl?: string };
  tokenInEnv: boolean;
  tokenHeld: boolean;
  shell: { name: string; path: string; kind: string };
  npmPrefix: string | null;
  presets: Preset[];
  lastTest: Record<string, AgentTest>;
  build: { fresh: boolean | null; reason: string | null };
  run: RunInfo | null;
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
  screenshot?: string;
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
}
