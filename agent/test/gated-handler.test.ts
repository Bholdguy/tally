// Wire-level integration: mock AssemblyAI socket -> real AgentSession -> gated handler -> real Gate -> real SQLite.
// Scenario B through the real session client: the stale tool.call is HELD, the agent receives the repair instruction on
// the wire, the order never contains the stale value, then the corrected call is ALLOWED.
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { makeRig, type Rig } from '../../reliability/test/rig.js';
import { AgentSession } from '../src/session.js';
import { Secret } from '../src/config.js';
import { createGatedHandler } from '../src/gated-handler.js';

let wss: WebSocketServer;
let sock: ServerSocket[] = [];
const got: any[] = [];
async function start(): Promise<string> {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (s) => { sock.push(s); s.on('message', (d) => { const m = JSON.parse(d.toString()); got.push(m); if (m.type === 'session.update') s.send(JSON.stringify({ type: 'session.ready', session_id: 'aai-1' })); }); });
  return `ws://127.0.0.1:${(wss.address() as any).port}`;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 2000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await wait(10); if (!f()) throw new Error('until timeout'); };
afterEach(async () => { for (const s of sock) s.terminate(); sock = []; got.length = 0; await new Promise<void>((r) => wss.close(() => r())); });

async function setup(rig: Rig) {
  const url = await start();
  const session = new AgentSession({
    config: { apiKey: new Secret('k-0000000'), wsUrl: url, restUrl: 'http://x' }, tallySessionId: rig.session, mode: 'demo', configVersion: 'v1',
    systemPrompt: 'p', handler: createGatedHandler(rig.gate, rig.session),
  });
  await session.connect();
  const toolCall = (id: string, name: string, args: unknown) => sock[0]!.send(JSON.stringify({ type: 'tool.call', call_id: id, name, arguments: args }));
  const result = async (id: string) => { await until(() => got.some((m) => m.type === 'tool.result' && m.call_id === id)); return JSON.parse(got.find((m) => m.type === 'tool.result' && m.call_id === id).result); };
  return { session, toolCall, result };
}

describe('Plane 1 gated handler over the wire (scenario B)', () => {
  it('stale call HELD with the repair instruction on the wire; order untouched; corrected call ALLOWED; duplicate is a NOOP; get_order_state reads the DB', async () => {
    const rig = makeRig();
    rig.up();
    rig.final('two burgers, no wait, make it three');
    const { session, toolCall, result } = await setup(rig);
    const before = rig.hash();

    toolCall('c1', 'add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    const held = await result('c1');
    expect(held.status).toBe('HELD');
    expect(held.code).toBe('QTY_MISMATCH');
    expect(held.instruction).toContain("Just to confirm, that's 3 classic burgers?");
    expect(held.instruction).toMatch(/Nothing was changed/);
    expect(rig.hash()).toBe(before);                                            // the order never held the stale 2

    rig.final('Yes, three.');
    toolCall('c2', 'add_item', { item_id: 'burger', quantity: 3, modifiers: [] });
    const ok = await result('c2');
    expect(ok).toMatchObject({ status: 'OK', total: '$26.97' });
    expect(rig.store.getOrder(rig.session)!.state.lines).toEqual([{ item_id: 'burger', quantity: 3, modifiers: [] }]);

    toolCall('c3', 'add_item', { item_id: 'burger', quantity: 3, modifiers: [] });   // the duplicate the agent really issued in 5/5 clean runs
    const noop = await result('c3');
    expect(noop.status).toBe('NOOP');
    expect(noop.message).toMatch(/Do not apologise/);

    // get_order_state is an INTERACTIVE tool: by the documented rule its result is sent only after reply.done
    toolCall('c4', 'get_order_state', {});
    await wait(100);
    expect(got.some((m) => m.type === 'tool.result' && m.call_id === 'c4')).toBe(false);
    sock[0]!.send(JSON.stringify({ type: 'reply.done', status: 'completed' }));
    expect(await result('c4')).toMatchObject({ status: 'OK', total: '$26.97' });
    await session.end();
    rig.close();
  });

  it('a misuse (update_quantity for an item not on the order) returns ERROR with the projection code and no customer question', async () => {
    const rig = makeRig();
    rig.up(); rig.final('three burgers');
    const { session, toolCall, result } = await setup(rig);
    toolCall('m1', 'update_quantity', { item_id: 'burger', quantity: 3 });
    const r = await result('m1');
    expect(r).toMatchObject({ status: 'ERROR', code: 'NOT_IN_ORDER' });
    expect(r.instruction).toBeUndefined();
    await session.end(); rig.close();
  });

  it('an unknown tool from the model is an ERROR, never success, never a write', async () => {
    const rig = makeRig();
    rig.up(); rig.final('two burgers');
    const { session, toolCall, result } = await setup(rig);
    const before = rig.hash();
    toolCall('u1', 'drop_tables', {});
    expect((await result('u1')).status).toBe('ERROR');
    expect(rig.hash()).toBe(before);
    await session.end(); rig.close();
  });

  it('the independent stream going DOWN while the agent waits yields HELD/UNVALIDATABLE on the wire (fail closed end to end)', async () => {
    const rig = makeRig();
    rig.up(); rig.final('two burgers.');
    const { session, toolCall, result } = await setup(rig);
    rig.down('socket closed');
    const before = rig.hash();
    toolCall('d1', 'add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    const r = await result('d1');
    expect(r).toMatchObject({ status: 'HELD', code: 'UNVALIDATABLE' });
    expect(rig.hash()).toBe(before);
    await session.end(); rig.close();
  });

  it('a handler that throws still yields ERROR on the wire (session-level fail closed, unchanged)', async () => {
    const rig = makeRig();
    const url = await start();
    const s = new AgentSession({ config: { apiKey: new Secret('k-0000000'), wsUrl: url, restUrl: 'http://x' }, tallySessionId: rig.session, mode: 'demo', configVersion: 'v1', systemPrompt: 'p', handler: async () => { throw new Error('boom'); } });
    await s.connect();
    sock[0]!.send(JSON.stringify({ type: 'tool.call', call_id: 'e1', name: 'add_item', arguments: {} }));
    await until(() => got.some((m) => m.type === 'tool.result'));
    expect(JSON.parse(got.find((m) => m.type === 'tool.result').result).status).toBe('ERROR');
    await s.end(); rig.close();
  });
});
