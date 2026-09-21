// Plane 1 configuration. The only place ASSEMBLYAI_API_KEY is read (SECURITY §2).

/** Wraps a secret so it cannot leak through logging, JSON or string interpolation. */
export class Secret {
  readonly #value: string;
  constructor(value: string) { this.#value = value; }
  reveal(): string { return this.#value; }
  toString(): string { return '[redacted]'; }
  toJSON(): string { return '[redacted]'; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return 'Secret([redacted])'; }
}

export interface AgentConfig {
  apiKey: Secret;
  wsUrl: string;
  restUrl: string;
  voice?: string;
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const key = env.ASSEMBLYAI_API_KEY?.trim();
  if (!key) throw new Error('ASSEMBLYAI_API_KEY is not set (copy .env.example to .env). Refusing to start.');
  return {
    apiKey: new Secret(key),
    wsUrl: env.AAI_WS_URL?.trim() || 'wss://agents.assemblyai.com/v1/ws',
    restUrl: env.AAI_REST_URL?.trim() || 'https://agents.assemblyai.com',
    voice: env.AAI_VOICE?.trim() || undefined,
  };
}
