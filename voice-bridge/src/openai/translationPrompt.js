import { config } from "../config.js";

const LANG_NAMES = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ru: "Russian",
  zh: "Mandarin Chinese",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  hi: "Hindi",
  tr: "Turkish",
  pl: "Polish",
  vi: "Vietnamese",
  th: "Thai",
  id: "Indonesian",
  uk: "Ukrainian",
  he: "Hebrew",
  el: "Greek",
  ro: "Romanian",
  cs: "Czech",
  sv: "Swedish",
  no: "Norwegian",
  da: "Danish",
  fi: "Finnish",
  hu: "Hungarian",
  ta: "Tamil",
  bn: "Bengali",
  ur: "Urdu",
  fa: "Persian",
};

/**
 * Map an ISO 639-1 code to a human-readable language name. Falls back to the
 * raw code in caps if unknown so the prompt still reads sensibly.
 */
export function languageName(code) {
  if (!code || code === "auto") return "the speaker's language";
  const lower = code.toLowerCase();
  return LANG_NAMES[lower] || code.toUpperCase();
}

/**
 * Build the translation system prompt for one direction of a call.
 * @param {string} sourceLang - ISO 639-1 code (or "auto")
 * @param {string} targetLang - ISO 639-1 code
 */
export function buildTranslationPrompt(sourceLang, targetLang) {
  const SOURCE = languageName(sourceLang);
  const TARGET = languageName(targetLang);

  return [
    `You are a real-time professional interpreter on a live phone call.`,
    `You will hear speech in ${SOURCE}. Output only spoken ${TARGET}.`,
    ``,
    `Hard rules:`,
    `- Translate everything the speaker says. Do not summarize, paraphrase, or omit any words.`,
    `- Match the speaker's tone and register exactly. Casual speech -> casual ${TARGET} with contractions and natural fillers. Formal speech -> formal ${TARGET}.`,
    `- Preserve all proper nouns, brand names, places, numbers, dates, prices, addresses, and codes verbatim. Do not localize them.`,
    `- Speak in the first person, AS the original speaker. Never add narration like "the speaker said" or your own greetings.`,
    `- If the speaker pauses mid-sentence, wait. Do not invent words to complete it.`,
    `- If you hear silence, music, or non-speech audio, stay silent. Do not produce filler.`,
    `- If a stretch of audio is already in ${TARGET}, repeat it as-is in your own voice. Do not translate it back.`,
    `- Speak at a steady, natural conversational pace. Do not editorialize.`,
  ].join("\n");
}

/**
 * Pick a voice for the given target language. Honors per-language env override
 * (OPENAI_VOICE_<LANG>, e.g. OPENAI_VOICE_ES) before falling back to the
 * global OPENAI_VOICE default.
 */
export function voiceFor(targetLang) {
  if (targetLang) {
    const key = `OPENAI_VOICE_${targetLang.toUpperCase()}`;
    const override = process.env[key];
    if (override) return override;
  }
  return config.openaiVoice;
}
