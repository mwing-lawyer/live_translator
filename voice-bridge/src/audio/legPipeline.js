import { mulawDecode, mulawEncode } from "./codec.js";
import { config } from "../config.js";

const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS) / 1000; // 160
const MAX_BUFFER_BYTES = SAMPLE_RATE * 2; // 2s of audio cap per buffer
const MULAW_SILENCE = 0xFF; // mu-law byte for digital zero

/**
 * One LegPipeline owns the audio path for a single Twilio leg's *ear*:
 * the audio that this leg's listener hears.
 *
 * It mixes:
 *   - originalQueue: mulaw frames from the OTHER leg's mic (the speaker)
 *   - translatedQueue: mulaw frames produced by OpenAI for THIS leg's ear
 *
 * It runs a 20 ms output pacer that always emits a frame to Twilio so the
 * listener never hears dead air. When translated audio is playing, the original
 * is ducked under it; when no translation is playing, the listener hears the
 * speaker's original voice at full volume.
 *
 * It also runs an energy VAD on the leg's OWN mic (pushOwnMic) so we can
 * implement soft barge-in: while this leg is speaking, we stop forcing
 * translated audio into their ear.
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
    this.originalQueue = [];
    this.originalLen = 0;
    /** @type {Buffer[]} */
    this.translatedQueue = [];
    this.translatedLen = 0;

    this.isSpeaking = false;
    this._timeAboveMs = 0;
    this._timeBelowMs = 0;

    this.closed = false;
    this.stats = {
      framesSent: 0,
      framesMixed: 0,
      framesBargedIn: 0,
      framesUnderrunOrig: 0,
      droppedOriginalBytes: 0,
      droppedTranslatedBytes: 0,
      hardClears: 0,
    };

    this._tickHandle = setInterval(() => this._tick(), FRAME_MS);
  }

  /**
   * Audio from the OTHER leg's mic, base64-encoded mulaw 8 kHz.
   */
  pushOriginal(mulawBase64) {
    if (this.closed || !mulawBase64) return;
    const buf = Buffer.from(mulawBase64, "base64");
    this.originalQueue.push(buf);
    this.originalLen += buf.length;
    while (this.originalLen > MAX_BUFFER_BYTES && this.originalQueue.length > 0) {
      const old = this.originalQueue.shift();
      this.originalLen -= old.length;
      this.stats.droppedOriginalBytes += old.length;
    }
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
    this.originalQueue = [];
    this.translatedQueue = [];
    this.originalLen = 0;
    this.translatedLen = 0;
    console.log(
      `Session ${this.sessionId}: ${this.role} pipeline closed ` +
      `framesSent=${this.stats.framesSent} mixed=${this.stats.framesMixed} ` +
      `bargedIn=${this.stats.framesBargedIn} hardClears=${this.stats.hardClears}`
    );
  }

  _tick() {
    if (this.closed) return;
    if (!this.ws || this.ws.readyState !== 1) return;

    const original = this._popExact("originalQueue", "originalLen", FRAME_BYTES);
    const translated = this._popExact("translatedQueue", "translatedLen", FRAME_BYTES);

    let outMulaw;

    if (translated && this.isSpeaking) {
      // Soft barge-in: discard the translated frame, listener hears their own
      // mic context via the original-from-other-leg path (or silence).
      outMulaw = original || this._silence();
      this.stats.framesBargedIn++;
    } else if (translated) {
      // Mix translated at full + original ducked.
      const orig = original || this._silence();
      outMulaw = this._mix(orig, translated, config.mix.duckGain, 1.0);
      this.stats.framesMixed++;
    } else {
      // No translation queued; pass through original at full volume.
      outMulaw = original
        ? (config.mix.originalGain === 1.0 ? original : this._scale(original, config.mix.originalGain))
        : this._silence();
      if (!original) this.stats.framesUnderrunOrig++;
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
        `sent=${this.stats.framesSent} mixed=${this.stats.framesMixed} ` +
        `bargedIn=${this.stats.framesBargedIn} origQ=${this.originalLen}B ` +
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

  _mix(aMulaw, bMulaw, gainA, gainB) {
    const len = Math.min(aMulaw.length, bMulaw.length);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      const a = mulawDecode(aMulaw[i]);
      const b = mulawDecode(bMulaw[i]);
      let mixed = Math.round(a * gainA + b * gainB);
      if (mixed > 32767) mixed = 32767;
      else if (mixed < -32768) mixed = -32768;
      out[i] = mulawEncode(mixed);
    }
    return out;
  }

  _scale(mulaw, gain) {
    const out = Buffer.alloc(mulaw.length);
    for (let i = 0; i < mulaw.length; i++) {
      let s = Math.round(mulawDecode(mulaw[i]) * gain);
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
      out[i] = mulawEncode(s);
    }
    return out;
  }
}
