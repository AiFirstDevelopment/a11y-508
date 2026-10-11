import { parseSse } from './sse';

describe('parseSse', () => {
  it('splits complete events and keeps the rest', () => {
    const r = parseSse('id: 0\ndata: {"type":"run"}\n\n: comment\n\nid: 1\ndata: {"type":"pa');
    expect(r.data).toEqual(['{"type":"run"}']);
    expect(r.rest).toBe('id: 1\ndata: {"type":"pa');
  });
  it('joins multi-line data and handles CRLF', () => {
    expect(parseSse('data: a\r\ndata: b\r\n\r\n').data).toEqual(['a\nb']);
  });
  it('returns nothing for an incomplete buffer', () => {
    expect(parseSse('data: x').data).toEqual([]);
  });
});
