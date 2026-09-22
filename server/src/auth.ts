// Two dashboard access tiers (D-39): GUEST (no login) can view everything read-only and trigger a demo scenario playback; OPERATOR
// (session-cookie login, using the SAME credential as the `x-tally-operator` header — no second secret) unlocks every mutating route.
// The tier is decided server-side on every request (app.ts calls `isOperator`/`requireOperator` before any write), never only by
// hiding a UI button. Sessions are held in memory only: a restart signs everyone out, exactly like the session runtimes.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const digest = (s: string) => createHash('sha256').update(s).digest();
export function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !provided) return false;
  return timingSafeEqual(digest(provided), digest(expected)); // constant-time; equal-length digests
}

export const SESSION_COOKIE = 'tally_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 h

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** In-memory session store: `/api/login` creates one, `/api/logout` or expiry destroys it. Not persisted (a restart signs everyone out). */
export class SessionStore {
  private sessions = new Map<string, number>(); // id -> expires_at (ms)
  create(): string {
    this.prune();
    const id = randomBytes(24).toString('hex');
    this.sessions.set(id, Date.now() + SESSION_TTL_MS);
    return id;
  }
  valid(id: string | undefined): boolean {
    if (!id) return false;
    const exp = this.sessions.get(id);
    if (exp === undefined) return false;
    if (exp < Date.now()) { this.sessions.delete(id); return false; }
    return true;
  }
  destroy(id: string | undefined): void { if (id) this.sessions.delete(id); }
  size(): number { this.prune(); return this.sessions.size; }
  private prune(): void { const now = Date.now(); for (const [id, exp] of this.sessions) if (exp < now) this.sessions.delete(id); }
}

// the cookie only needs `Secure` when the browser's own connection is https; Render (and any TLS-terminating proxy) says so via
// x-forwarded-proto, so a cookie set over plain loopback HTTP in local dev still works
const isHttps = (req: FastifyRequest): boolean => req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
const cookieAttrs = (req: FastifyRequest, extra: string[]): string => ['HttpOnly', 'Path=/', 'SameSite=Strict', ...extra, ...(isHttps(req) ? ['Secure'] : [])].join('; ');
export const setSessionCookie = (req: FastifyRequest, reply: FastifyReply, id: string): void => { reply.header('set-cookie', `${SESSION_COOKIE}=${id}; ${cookieAttrs(req, [`Max-Age=${SESSION_TTL_MS / 1000}`])}`); };
export const clearSessionCookie = (req: FastifyRequest, reply: FastifyReply): void => { reply.header('set-cookie', `${SESSION_COOKIE}=; ${cookieAttrs(req, ['Max-Age=0'])}`); };

/** OPERATOR if either the header token matches (scripts, `smoke:deployed`, any other API client) or a valid session cookie is present. */
export function isOperator(req: FastifyRequest, operatorToken: string, sessions: SessionStore): boolean {
  if (tokenMatches(req.headers['x-tally-operator'], operatorToken)) return true;
  return sessions.valid(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}
