// A Server-Sent Events parser. EventSource cannot send the session-secret
// header, so the stream is read with fetch and parsed here.

export interface SseParse {
  data: string[];
  rest: string;
}

// Splits complete events off the front of a buffer; returns their data
// fields and whatever incomplete text is left.
export function parseSse(buffer: string): SseParse {
  const data: string[] = [];
  const text = buffer.replace(/\r\n/g, '\n');
  const blocks = text.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.startsWith('data:'));
    if (!lines.length) continue;
    data.push(lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n'));
  }
  return { data, rest };
}

export async function readSse(response: Response, onData: (data: string) => void): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { data, rest } = parseSse(buffer);
    buffer = rest;
    for (const d of data) onData(d);
  }
  const { data } = parseSse(buffer + '\n\n');
  for (const d of data) onData(d);
}
