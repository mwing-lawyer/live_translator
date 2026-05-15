const required = (name) => {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
};

const optional = (name, fallback) => process.env[name] || fallback;

const optionalBool = (name, fallback) => {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
};

// The /v1/realtime/translations endpoint hardcodes PCM16 24 kHz on the wire and
// rejects explicit format parameters. Kept as an env var for forward compat,
// but anything other than "pcm16" is forced to "pcm16" downstream.
const audioFormat = optional("OPENAI_AUDIO_FORMAT", "pcm16").toLowerCase();
if (audioFormat !== "pcm16") {
  throw new Error(`OPENAI_AUDIO_FORMAT must be "pcm16" on the translations endpoint, got "${audioFormat}"`);
}

export const config = {
  port: parseInt(optional("PORT", "8080"), 10),
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiModel: optional("OPENAI_MODEL", "gpt-realtime-translate"),
  openaiAudioFormat: audioFormat,
  callbackUrl: optional("CALLBACK_URL", ""),
  logLevel: optional("LOG_LEVEL", "info"),

  vad: {
    threshold: parseFloat(optional("VAD_THRESHOLD", "0.5")),
    prefixPaddingMs: parseInt(optional("VAD_PREFIX_PADDING_MS", "300"), 10),
    silenceDurationMs: parseInt(optional("VAD_SILENCE_DURATION_MS", "500"), 10),
  },

  bridgeVad: {
    rmsThreshold: parseFloat(optional("BRIDGE_VAD_RMS_THRESHOLD", "600")),
    speakHoldMs: parseInt(optional("BRIDGE_VAD_SPEAK_HOLD_MS", "60"), 10),
    silenceHoldMs: parseInt(optional("BRIDGE_VAD_SILENCE_HOLD_MS", "200"), 10),
  },

  bargeInHardCut: optionalBool("BARGE_IN_HARD_CUT", false),

  session: {
    pairTimeoutMs: parseInt(optional("SESSION_PAIR_TIMEOUT_MS", "30000"), 10),
    orphanCheckIntervalMs: parseInt(optional("ORPHAN_CHECK_INTERVAL_MS", "60000"), 10),
  },
};
