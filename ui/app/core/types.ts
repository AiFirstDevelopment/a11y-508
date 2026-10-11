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

export interface EnvInfo {
  cwd: string;
  version: string;
  platform: string;
  browser: { found: boolean; path: string | null; error?: string };
  config: { exists: boolean; file: string };
  session: { exists: boolean; file: string; ageMs?: number; capturedAt?: string | null };
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
  details?: unknown;
  page?: string;
  pages?: string[];
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
}

export interface Report {
  id: string;
  baseUrl: string;
  finishedAt: string;
  passed: boolean;
  options: { failOn: string[] };
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
  catalog: Record<string, { name: string; wcag: string; condition: string; automation: string }>;
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
