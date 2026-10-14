import { diagnosticsText, entryTime } from './diagnostics';

describe('diagnostics', () => {
  const e = (i: number, details: string[] = []) => ({ at: `2026-10-14T20:${String(i).padStart(2, '0')}:00.000Z`, type: 'kill', text: `entry ${i}`, details });

  it('copies the newest 50 entries as text, each with its details indented', () => {
    const list = Array.from({ length: 60 }, (_, i) => e(59 - i, i === 0 ? ['exit code 1, signal none'] : []));
    const text = diagnosticsText(list);
    const rows = text.split('\n');
    expect(rows[0]).toBe('2026-10-14T20:59:00.000Z  entry 59');
    expect(rows[1]).toBe('    exit code 1, signal none');
    expect(rows.length).toBe(51);
    expect(rows[50]).toBe('2026-10-14T20:10:00.000Z  entry 10');
  });

  it('reads a time as a person does, and keeps what it cannot read', () => {
    expect(entryTime('2026-10-14T20:52:07.000Z')).toMatch(/^Oct 1[45], \d{1,2}:52:07 [AP]M$/);
    expect(entryTime('not a time')).toBe('not a time');
  });
});
