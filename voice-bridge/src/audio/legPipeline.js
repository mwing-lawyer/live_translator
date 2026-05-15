import { mulawDecode } from "./codec.js";
import { config } from "../config.js";

const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS) / 1000; // 160
const MAX_BUFFER_BYTES = SAMPLE_RATE * 2; // 2s of audio cap on translated buffer
const MULAW_SILENCE = 0xFF; // mu-law byte for digital zero

/**
 * One LegPipeline owns the audio path for a single Twilio leg's *ear*:
 * the audio that this leg's listener hears.
 *
 * It buffers translated mulaw frames produced by OpenAI for THIS leg's ear
 * and emits them on a 20 ms pacer so Twilio sees a steady cadence. When no
 * translated frame is queued, silence is emitted (the listener never hears
 * the speaker's original voice).
 *
 * It also runs an energy VAD on the leg's OWN mic (pushOwnMic) so we can
 * implement soft barge-in: while this leg is speaking, queued translated
 * frames are dropped so the listener can hear themselves immediately.
 */
export class LegPipeline {
  /**
   * @param {object} opts
   * @param {import("ws").WebSocket} opts.ws
   * @param {string} opts.streamSid
   * @param {string} opts.role
   * @param {string} opts.sessionId
   * @param {(isSpeaking: boolean) => void} [opts.onSelfSpeechChange]
   */
  constructor({ ws, streamSid, role, sessionId, onSelfSpeechChange }) {
    this.ws = ws;
    this.streamSid = streamSid;
    this.role = role;
    this.sessionId = sessionId;
    this.onSelfSpeechChange = onSelfSpeechChange || (() => {});

    /** @type {Buffer[]} */
    this.translatedQueue = [];
    this.translatedLen = 0;

    this.isSpeaking = false;
    this._timeAboveMs = 0;
    this._timeBelowMs = 0;

    this.closed = false;
    this.stats = {
      framesSent: 0,
      framesTranslated: 0,
      framesSilent: 0,
      framesBargedIn: 0,
      droppedTranslatedBytes: 0,
      hardClears: 0,
    };

    this._tickHandle = setInterval(() => this._tick(), FRAME_MS);
  }

  /**
   * Translated audio from OpenAI for this leg's ear, base64-encoded mulaw 8 kHz.
   */
  pushTranslated(mulawBase64) {
    if (this.closed || !mulawBase64) return;
    const buf = Buffer.from(mulawBase64, "base64");
    this.translatedQueue.push(buf);
    this.translatedLen += buf.length;
    while (this.translatedLen > MAX_BUFFER_BYTES && this.translatedQueue.length > 0) {
      const old = this.translatedQueue.shift();
      this.translatedLen -= old.length;
      this.stats.droppedTranslatedBytes += old.length;
    }
  }

  /**
   * Audio from THIS leg's own mic, used only for VAD (barge-in detection).
   * Does not affect what is sent back to Twilio.
   */
  pushOwnMic(mulawBase64) {
    if (this.closed || !mulawBase64) return;
    const buf = Buffer.from(mulawBase64, "base64");
    if (buf.length === 0) return;
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const s = mulawDecode(buf[i]);
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / buf.length);
    const ms = (buf.length * 1000) / SAMPLE_RATE;

    if (rms >= config.bridgeVad.rmsThreshold) {
      this._timeAboveMs += ms;
      this._timeBelowMs = 0;
    } else {
      this._timeBelowMs += ms;
      this._timeAboveMs = 0;
    }

    if (!this.isSpeaking && this._timeAboveMs >= config.bridgeVad.speakHoldMs) {
      this.isSpeaking = true;
      console.log(`Session ${this.sessionId}: ${this.role} VAD -> speaking (rms=${rms.toFixed(0)})`);
      this.onSelfSpeechChange(true);
    } else if (this.isSpeaking && this._timeBelowMs >= config.bridgeVad.silenceHoldMs) {
      this.isSpeaking = false;
      console.log(`Session ${this.sessionId}: ${this.role} VAD -> silent`);
      this.onSelfSpeechChange(false);
    }
  }

  /**
   * Hard barge-in: drop all queued translated audio immediately.
   */
  clearTranslated() {
    if (this.closed) return;
    if (this.translatedLen > 0) {
      console.log(
        `Session ${this.sessionId}: ${this.role} clearTranslated dropped ${this.translatedLen} bytes`
      );
      this.stats.hardClears++;
    }
    this.translatedQueue = [];
    this.translatedLen = 0;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._tickHandle) {
      clearInterval(this._tickHandle);
      this._tickHandle = null;
    }
    this.translatedQueue = [];
    this.translatedLen = 0;
    console.log(
      `Session ${this.sessionId}: ${this.role} pipeline closed ` +
      `framesSent=${this.stats.framesSent} translated=${this.stats.framesTranslated} ` +
      `silent=${this.stats.framesSilent} bargedIn=${this.stats.framesBargedIn} ` +
      `hardClears=${this.stats.hardClears}`
    );
  }

  _tick() {
    if (this.closed) return;
    if (!this.ws || this.ws.readyState !== 1) return;

    const translated = this._popExact("translatedQueue", "translatedLen", FRAME_BYTES);

    let outMulaw;
    if (translated && this.isSpeaking) {
      outMulaw = this._silence();
      this.stats.framesBargedIn++;
    } else if (translated) {
      outMulaw = translated;
      this.stats.framesTranslated++;
    } else {
      outMulaw = this._silence();
      this.stats.framesSilent++;
    }

    this.ws.send(JSON.stringify({
      event: "media",
      streamSid: this.streamSid,
      media: { payload: outMulaw.toString("base64") },
    }));

    this.stats.framesSent++;
    if (this.stats.framesSent === 1) {
      console.log(
        `Session ${this.sessionId}: ${this.role} pipeline first frame sent`
      );
    } else if (this.stats.framesSent % 1000 === 0) {
      console.log(
        `Session ${this.sessionId}: ${this.role} pipeline ` +
        `sent=${this.stats.framesSent} translated=${this.stats.framesTranslated} ` +
        `silent=${this.stats.framesSilent} bargedIn=${this.stats.framesBargedIn} ` +
        `txQ=${this.translatedLen}B speaking=${this.isSpeaking}`
      );
    }
  }

  _popExact(queueField, lenField, want) {
    if (this[lenField] < want) return null;
    const out = Buffer.alloc(want);
    let written = 0;
    const queue = this[queueField];
    while (written < want && queue.length > 0) {
      const head = queue[0];
      const need = want - written;
      if (head.length <= need) {
        head.copy(out, written);
        written += head.length;
        queue.shift();
      } else {
        head.copy(out, written, 0, need);
        queue[0] = head.subarray(need);
        written += need;
      }
    }
    this[lenField] -= want;
    return out;
  }

  _silence() {
    return Buffer.alloc(FRAME_BYTES, MULAW_SILENCE);
  }
}
