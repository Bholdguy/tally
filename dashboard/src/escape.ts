// Every string that came from a customer, an agent, a transcript, an API response or a stored row is HTML-escaped before it is placed in
// the page (the transcripts are attacker-controlled text: "<img onerror=...>" said aloud is a valid utterance). There is no innerHTML
// path that does not go through `esc`, and the CSP forbids inline script as a second layer.
const MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"'`]/g, (c) => MAP[c]!);
/** a value destined for an attribute: escaped, and additionally stripped of anything but a conservative id alphabet */
export const idAttr = (v: unknown): string => esc(String(v ?? '').replace(/[^A-Za-z0-9_.:\-|]/g, ''));
