import { landing } from './resume';

describe('landing', () => {
  it('opens on the stored step when it is a wizard step', () => {
    expect(landing({ run: null, lastStep: '/fix-loop' })).toBe('/fix-loop');
    expect(landing({ run: null, lastStep: '/report' })).toBe('/report');
  });

  it('ignores a step stored by an older build for a screen that no longer exists', () => {
    expect(landing({ run: null, lastStep: '/review' })).toBe(null);
    expect(landing({ run: null, lastStep: '/anything-else' })).toBe(null);
    expect(landing({ run: null, lastStep: null })).toBe(null);
  });

  it('prefers a live run over the stored step', () => {
    expect(landing({ run: { status: 'running', kind: 'loop' } as any, lastStep: '/review' })).toBe('/fix-loop');
    expect(landing({ run: { status: 'running', kind: 'crawl' } as any, lastStep: '/report' })).toBe('/live');
  });
});
