// Baseline config bootstrap (Step 9): the prompt and gating parameters this build ships with become version `v1`, once.
import { buildSystemPrompt } from '@tally/agent';
import { toolDeclarations } from '@tally/contract';
import type { GatingParams, Store } from '@tally/reliability';

export function envGating(env: NodeJS.ProcessEnv): Required<Pick<GatingParams, 'evidenceWaitMaxMs' | 'minWordConfidence' | 'sttStallMs' | 'regressionThreshold'>> {
  const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);
  return { evidenceWaitMaxMs: num('EVIDENCE_WAIT_MAX_MS', 4000), minWordConfidence: num('MIN_WORD_CONFIDENCE', 0.6), sttStallMs: num('STT_STALL_MS', 2500), regressionThreshold: num('REGRESSION_THRESHOLD', 3) };
}

/** Creates and activates baseline `v1` if the registry is empty. Idempotent. */
export function ensureBaseline(store: Store, env: NodeJS.ProcessEnv = process.env): void {
  if (store.listConfigs().length > 0) return;
  store.createConfig({ version: 'v1', prompt_text: buildSystemPrompt(), tool_schema_json: JSON.stringify(toolDeclarations()), gating_params: envGating(env), parent_version: null, actor: 'system' });
  store.activateBaseline('v1');
}
