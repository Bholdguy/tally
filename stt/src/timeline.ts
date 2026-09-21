// Read-only REST client for AssemblyAI's stored Voice Agent session timeline (option C, D-19).
// Used for post-hoc reconciliation only. Artifact URLs are pre-signed and short-lived: store the session id and re-fetch.
export interface TimelineTurnRaw {
  turn_id?: string; trigger?: string; status?: string;
  user_transcript: string | null; user_confidence: number | null;
  user_speech_started_at_ms?: number | null; user_speech_ended_at_ms?: number | null;
  agent_text?: string | null;
  tool_calls?: { call_id: string; name: string; arguments: unknown; result?: string; dispatched_at_ms?: number; result_received_at_ms?: number | null }[];
}
export interface SessionTimeline { session_id: string; started_at_unix_ms: number; turns: TimelineTurnRaw[] }

export async function fetchSessionTimeline(opts: { apiKey: { reveal(): string }; restUrl?: string; sessionId: string; fetchImpl?: typeof fetch }): Promise<SessionTimeline> {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.restUrl ?? 'https://agents.assemblyai.com';
  const auth = { Authorization: `Bearer ${opts.apiKey.reveal()}` };
  const meta = await f(`${base}/v1/sessions/${opts.sessionId}`, { headers: auth });
  if (!meta.ok) throw new Error(`session fetch failed: HTTP ${meta.status}`);
  const j = (await meta.json()) as { artifacts?: { type: string; url: string }[] };
  const url = j.artifacts?.find((a) => a.type === 'timeline')?.url;
  if (!url) throw new Error('session has no timeline artifact yet');
  const tl = await f(url); // pre-signed URL: do NOT send the API key to it
  if (!tl.ok) throw new Error(`timeline download failed: HTTP ${tl.status}`);
  return (await tl.json()) as SessionTimeline;
}
