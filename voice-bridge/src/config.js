const required = (name) => {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
};

const optional = (name, fallback) => process.env[name] || fallback;

export const config = {
  port: parseInt(optional("PORT", "8080"), 10),
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiModel: optional("OPENAI_MODEL", "gpt-4o-realtime-preview"),
  callbackUrl: optional("CALLBACK_URL", ""),
  logLevel: optional("LOG_LEVEL", "info"),

  vad: {
    threshold: parseFloat(optional("VAD_THRESHOLD", "0.5")),
    prefixPaddingMs: parseInt(optional("VAD_PREFIX_PADDING_MS", "300"), 10),
    silenceDurationMs: parseInt(optional("VAD_SILENCE_DURATION_MS", "500"), 10),
  },

  session: {
    pairTimeoutMs: parseInt(optional("SESSION_PAIR_TIMEOUT_MS", "30000"), 10),
    orphanCheckIntervalMs: parseInt(optional("ORPHAN_CHECK_INTERVAL_MS", "60000"), 10),
  },
};
