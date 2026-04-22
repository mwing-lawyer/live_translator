import { RealtimeClient } from "../openai/RealtimeClient.js";
import { twilioToOpenAI, openAIToTwilio } from "../audio/codec.js";
import { notify } from "../callbacks/notifier.js";

const STATES = {
  WAITING: "waiting",
  ACTIVE: "active",
  CLOSING: "closing",
  CLOSED: "closed",
};

const LANG_NAMES = {
  en: "English",
  es: "Spanish",
  fr: "French",
  pt: "Portuguese",
  de: "German",
  it: "Italian",
  hi: "Hindi",
  zh: "Mandarin Chinese",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  ru: "Russian",
  pl: "Polish",
  nl: "Dutch",
  tr: "Turkish",
  vi: "Vietnamese",
  th: "Thai",
  tl: "Tagalog",
  uk: "Ukrainian",
  he: "Hebrew",
  sw: "Swahili",
};

function langName(code) {
  return LANG_NAMES[code] || code;
}

function buildInstructions(fromLang, toLang) {
  const from = langName(fromLang);
  const to = langName(toLang);
  return (
    `You are a real-time voice translator. Listen to the incoming ${from} audio ` +
    `and produce a faithful ${to} translation. Speak only the translation, nothing else. ` +
    `Preserve tone and urgency. Do not add commentary.`
  );
}

export class TranslationSession {
  /**
   * @param {string} sessionId - Unique session identifier from PHP
   * @param {() => void} onDestroyed - Callback when session is fully torn down
   */
  constructor(sessionId, onDestroyed) {
    this.sessionId = sessionId;
    this.state = STATES.WAITING;
    this.createdAt = new Date();
    this.onDestroyed = onDestroyed;

    this.callerWs = null;
    this.repWs = null;
    this.callerStreamSid = null;
    this.repStreamSid = null;
    this.callerLang = null;
    this.repLang = null;

    this.callerToRepClient = null;
    this.repToCallerClient = null;
  }

  /**
   * Attach a Twilio Media Stream leg to this session.
   * @param {string} lang - ISO 639-1 language code (e.g. "hi", "en", "es")
   */
  attachLeg(role, ws, streamSid, lang) {
    if (this.state === STATES.CLOSING || this.state === STATES.CLOSED) {
      console.warn(`Session ${this.sessionId}: refusing attach, state=${this.state}`);
      return;
    }

    if (role === "caller") {
      this.callerWs = ws;
      this.callerStreamSid = streamSid;
      this.callerLang = lang || "es";
    } else if (role === "rep") {
      this.repWs = ws;
      this.repStreamSid = streamSid;
      this.repLang = lang || "en";
    } else {
      console.warn(`Session ${this.sessionId}: unknown role "${role}"`);
      return;
    }

    console.log(`Session ${this.sessionId}: ${role} leg attached (streamSid=${streamSid}, lang=${lang})`);

    if (this.callerWs && this.repWs && this.state === STATES.WAITING) {
      this._startTranslation();
    }
  }

  _startTranslation() {
    this.state = STATES.ACTIVE;
    const dirLabel = `${this.callerLang}->${this.repLang}`;
    const revLabel = `${this.repLang}->${this.callerLang}`;
    console.log(`Session ${this.sessionId}: both legs paired, starting translation (${dirLabel} / ${revLabel})`);

    this.callerToRepClient = new RealtimeClient({
      instructions: buildInstructions(this.callerLang, this.repLang),
      onAudioDelta: (base64Pcm) => {
        const payload = openAIToTwilio(base64Pcm);
        this._sendToTwilio(this.repWs, this.repStreamSid, payload);
      },
      onResponseStart: () => {
        this._clearTwilioBuffer(this.repWs, this.repStreamSid);
      },
      onTranscript: (text, isFinal) => {
        notify(this.sessionId, "caller", dirLabel, text, isFinal);
      },
      onError: (err) => {
        console.error(`Session ${this.sessionId} ${dirLabel} error:`, err.message);
      },
    });

    this.repToCallerClient = new RealtimeClient({
      instructions: buildInstructions(this.repLang, this.callerLang),
      onAudioDelta: (base64Pcm) => {
        const payload = openAIToTwilio(base64Pcm);
        this._sendToTwilio(this.callerWs, this.callerStreamSid, payload);
      },
      onResponseStart: () => {
        this._clearTwilioBuffer(this.callerWs, this.callerStreamSid);
      },
      onTranscript: (text, isFinal) => {
        notify(this.sessionId, "rep", revLabel, text, isFinal);
      },
      onError: (err) => {
        console.error(`Session ${this.sessionId} ${revLabel} error:`, err.message);
      },
    });
  }

  /**
   * Called when a Twilio media chunk arrives from a leg.
   */
  onTwilioAudio(role, base64Mulaw) {
    if (this.state !== STATES.ACTIVE) return;

    const pcm16Base64 = twilioToOpenAI(base64Mulaw);

    if (role === "caller" && this.callerToRepClient) {
      this.callerToRepClient.sendAudio(pcm16Base64);
    } else if (role === "rep" && this.repToCallerClient) {
      this.repToCallerClient.sendAudio(pcm16Base64);
    }
  }

  _sendToTwilio(ws, streamSid, base64Mulaw) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: base64Mulaw },
    }));
  }

  _clearTwilioBuffer(ws, streamSid) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ event: "clear", streamSid }));
  }

  onLegDisconnected(role) {
    if (this.state === STATES.CLOSING || this.state === STATES.CLOSED) return;
    console.log(`Session ${this.sessionId}: ${role} leg disconnected`);
    this.destroy();
  }

  destroy() {
    if (this.state === STATES.CLOSED) return;
    this.state = STATES.CLOSING;
    console.log(`Session ${this.sessionId}: tearing down`);

    this.callerToRepClient?.close();
    this.repToCallerClient?.close();

    if (this.callerWs?.readyState === 1) this.callerWs.close();
    if (this.repWs?.readyState === 1) this.repWs.close();

    this.callerToRepClient = null;
    this.repToCallerClient = null;
    this.callerWs = null;
    this.repWs = null;

    this.state = STATES.CLOSED;
    this.onDestroyed();
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      state: this.state,
      createdAt: this.createdAt.toISOString(),
      callerLang: this.callerLang,
      repLang: this.repLang,
      callerStreamSid: this.callerStreamSid,
      repStreamSid: this.repStreamSid,
      hasCallerLeg: this.callerWs !== null,
      hasRepLeg: this.repWs !== null,
      hasCallerToRepClient: this.callerToRepClient !== null,
      hasRepToCallerClient: this.repToCallerClient !== null,
    };
  }
}
