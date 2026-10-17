import { TestBed } from '@angular/core/testing';
import { Driver, PREFERENCE } from './driver';
import { EnvStore } from './env.store';
import { Preset } from './types';

const preset = (name: string, label: string, found: boolean): Preset => ({ name, label, bin: name, found, path: found ? `/usr/local/bin/${name}` : null, where: found ? 'PATH' : null, version: found ? '1.0.0' : null, command: name, install: `npm install -g ${name}` });

// docs/plans/manual-findings.md AC 10 / guard l: Gemini is the default assistant when nothing is chosen.
describe('Driver.agent', () => {
  let driver: Driver;
  let env: EnvStore;
  beforeEach(() => {
    // The server is not there: every request fails and the driver keeps what it has.
    globalThis.fetch = (() => Promise.reject(new Error('no server'))) as typeof fetch;
    env = TestBed.inject(EnvStore);
    driver = TestBed.inject(Driver);
  });

  it('prefers Gemini, then Claude, then Codex', () => {
    expect(PREFERENCE).toEqual(['gemini', 'claude', 'codex']);
  });
  it('is Gemini with both Claude Code and Gemini CLI installed and nothing chosen', () => {
    env.env.set({ cwd: '/app', presets: [preset('claude', 'Claude Code', true), preset('gemini', 'Gemini CLI', true), preset('codex', 'Codex', true)] } as any);
    expect(driver.agent()).toBe('gemini');
    // The second installed one is the fallback.
    expect(driver.fallback()).toBe('claude');
  });
  it('is Claude Code when Gemini CLI is not installed', () => {
    env.env.set({ cwd: '/app', presets: [preset('claude', 'Claude Code', true), preset('gemini', 'Gemini CLI', false)] } as any);
    expect(driver.agent()).toBe('claude');
  });
  it('is the one chosen under Advanced, or the config\'s, when one is', () => {
    env.env.set({ cwd: '/app', presets: [preset('claude', 'Claude Code', true), preset('gemini', 'Gemini CLI', true)] } as any);
    driver.cfg.set({ agent: 'claude' });
    expect(driver.agent()).toBe('claude');
    driver.settingsAgent.set('codex');
    expect(driver.agent()).toBe('codex');
  });
});
