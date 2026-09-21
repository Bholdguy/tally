// The dashboard's ONLY door to anything: this server's /api (same origin). The operator token goes in a header, never in a URL (SSE is
// read with fetch, not EventSource, because EventSource cannot set headers). The page never contacts AssemblyAI.
export class ApiError extends Error { constructor(readonly status: number, readonly body: any) { super(`HTTP ${status}${body?.error ? `: ${body.error}` : ''}`); } }

export interface Api {
  get(path: string): Promise<any>;
  post(path: string, body?: unknown): Promise<any>;
  blob(path: string): Promise<Blob>;
  /** stream typed events until aborted; resolves when the stream ends */
  stream(path: string, onEvent: (e: any) => void, signal?: AbortSignal): Promise<void>;
}

export function createApi(getToken: () => string, base = ''): Api {
  const headers = (json = false): Record<string, string> => ({ 'x-tally-operator': getToken(), ...(json ? { 'content-type': 'application/json' } : {}) });
  const parse = async (r: Response) => { const text = await r.text(); let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = { error: 'bad_response' }; } if (!r.ok) throw new ApiError(r.status, body); return body; };
  return {
    get: async (p) => parse(await fetch(base + p, { headers: headers() })),
    post: async (p, body) => parse(await fetch(base + p, { method: 'POST', headers: headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) })),
    blob: async (p) => { const r = await fetch(base + p, { headers: headers() }); if (!r.ok) throw new ApiError(r.status, null); return r.blob(); },
    stream: async (p, onEvent, signal) => {
      const r = await fetch(base + p, { headers: headers(), signal });
      if (!r.ok || !r.body) throw new ApiError(r.status, null);
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch { /* a malformed frame is dropped, never rendered */ } }
        }
      }
    },
  };
}
