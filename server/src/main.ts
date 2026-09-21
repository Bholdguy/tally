// Entry point (`npm run serve`). Refuses to start unsafely (SECURITY §2-3): no API key, no operator token, or a non-loopback
// bind without an explicit opt-in. The key is read ONLY by the agent's config loader and never leaves the server process.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentConfig } from '@tally/agent';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import { buildApp } from './app.js';
import { ensureBaseline, envGating } from './bootstrap.js';
import { SessionRuntime } from './runtime.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export interface SafeConfig { host: string; port: number; operatorToken: string; dbPath: string; audioDir: string; origin?: string }

/** Pure: validate the environment. Throws with a specific reason instead of starting in an unsafe state. */
export function assertSafeConfig(env: NodeJS.ProcessEnv): SafeConfig {
  loadAgentConfig(env); // throws if ASSEMBLYAI_API_KEY is missing
  const operatorToken = env.TALLY_OPERATOR_TOKEN?.trim() ?? '';
  if (operatorToken.length < 16) throw new Error('TALLY_OPERATOR_TOKEN must be set to at least 16 characters. Refusing to start.');
  const host = env.HOST?.trim() || '127.0.0.1';
  if (!LOOPBACK.has(host) && env.TALLY_ALLOW_REMOTE !== '1') throw new Error(`HOST=${host} is not loopback and TALLY_ALLOW_REMOTE is not 1. Refusing to start.`);
  return {
    host, port: Number(env.PORT ?? 8787), operatorToken,
    dbPath: env.TALLY_DB_PATH?.trim() || './data/tally.sqlite', audioDir: env.TALLY_AUDIO_DIR?.trim() || './data/audio',
    origin: env.DASHBOARD_ORIGIN?.trim() || undefined,
  };
}

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const cfg = assertSafeConfig(env);
  const agentConfig = loadAgentConfig(env);
  initDatabase(cfg.dbPath);
  const store = new Store(cfg.dbPath);
  const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);
  const gating = envGating(env);
  // Step 9: the baseline version is the prompt and gating parameters this build ships with; activated once, without a suite (nothing to regress against yet)
  ensureBaseline(store, env);
  const { app, runtimes } = await buildApp({
    operatorToken: cfg.operatorToken, allowedOrigin: cfg.origin, cases: store,
    demo: { audioDir: join(dirname(cfg.audioDir), 'demo-audio'), runtime: () => { const g = { ...gating, ...(store.activeConfig()?.gating_params ?? {}) }; return { configVersion: store.activeConfig()?.version, evidenceWaitMaxMs: g.evidenceWaitMaxMs, minWordConfidence: g.minWordConfidence, sttStallMs: g.sttStallMs, regressionThreshold: g.regressionThreshold }; } },
    startRuntime: ({ mode, systemPrompt, configVersion }) => {
      // new sessions run the ACTIVE config unless a specific one is under test (audio-tier replay of a candidate)
      const active = store.activeConfig();
      const under = configVersion ? store.getConfig(configVersion) : active;
      const g = { ...gating, ...(under?.gating_params ?? {}) };
      return SessionRuntime.start({
        agentConfig, store, audioDir: cfg.audioDir, mode: mode ?? 'live', configVersion: under?.version, systemPrompt: systemPrompt ?? under?.prompt_text,
        evidenceWaitMaxMs: g.evidenceWaitMaxMs, minWordConfidence: g.minWordConfidence, sttStallMs: g.sttStallMs,
        vad: { offHangoverMs: num('LOCAL_VAD_HANGOVER_MS', 300) }, regressionThreshold: g.regressionThreshold, maxRepairAttempts: under?.gating_params.maxRepairAttempts,
      });
    },
  });
  await app.listen({ host: cfg.host, port: cfg.port });
  return { app, runtimes, store, cfg, close: async () => { await app.close(); store.close(); } };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startServer().then(({ cfg }) => console.log(`tally server listening on http://${cfg.host}:${cfg.port} (operator token required for /api)`))
    .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
