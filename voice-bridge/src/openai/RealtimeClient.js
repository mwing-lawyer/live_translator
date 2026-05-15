import WebSocket from "ws";
import { config } from "../config.js";

const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime/translations?model=${config.openaiModel}`;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_MS = 1000;
const TRANSCRIPT_IDLE_MS = 1200;

export class RealtimeClient {
  /**
   * @param {object} opts
   * @param {string} opts.targetLanguage - ISO 639-1 code for the output language (e.g. "en", "es")
   * @param {string} [opts.sourceLanguage] - ISO 639-1 code for the source language (used in log lines only;
   *        the translations endpoint rejects audio.input.transcription.language and auto-detects).
   * @param {string} [opts.logLabel] - Direction tag prefixed on every log line (e.g. "en->es"). Defaults to targetLanguage.
   * @param {(b64Pcm16: string) => void} opts.onAudioDelta - Called per translated audio chunk (PCM16 24 kHz, base64).
   * @param {(text: string, isFinal: boolean) => void} opts.onTranscript - Called on translated transcript events
   * @param {(text: string, isFinal: boolean) => void} [opts.onSourceTranscript] - Called on source-language transcript events
   * @param {() => void} [opts.onReady] - Called when session is configured and ready
   * @param {(format: "pcm16") => void} [opts.onAudioFormatNegotiated] - Called when the effective wire format is known
   * @param {(err: Error) => void} [opts.onError] - Called on unrecoverable errors
   */
  constructor(opts) {
    this.opts = opts;
    this.targetLanguage = opts.targetLanguage;
    this.sourceLanguage = opts.sourceLanguage;
    this.logLabel = opts.logLabel || opts.targetLanguage || "?";
    // The translations endpoint hardcodes PCM16 24 kHz. Pin and warn if anything else slips through.
    this.audioFormat = "pcm16";

    this.onAudioDelta = opts.onAudioDelta;
    this.onTranscript = opts.onTranscript || (() => {});
    this.onSourceTranscript = opts.onSourceTranscript || (() => {});
    this.onReady = opts.onReady || (() => {});
    this.onAudioFormatNegotiated = opts.onAudioFormatNegotiated || (() => {});
    this.onError = opts.onError || ((err) => this._log(`error: ${err.message}`, "error"));

    this.closed = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.ws = null;

    this.eventCounts = {};
    this.totalEvents = 0;
    this.unknownEventTypes = new Set();
    this.firstSeen = new Set();
    this.audioPacketsSent = 0;
    this.audioDeltasReceived = 0;

    this.lastInputFrameAt = 0;
    this.lastOutputAudioAt = 0;

    this._inputBuf = "";
    this._outputBuf = "";
    this._inputFlushTimer = null;
    this._outputFlushTimer = null;

    this._connect();
  }

  _log(message, level = "log") {
    const prefix = `OpenAI[${this.logLabel}]:`;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`${prefix} ${message}`);
  }

  _logFirst(key, message) {
    if (this.firstSeen.has(key)) return;
    this.firstSeen.add(key);
    this._log(message);
  }

  _appendTranscript(which, delta) {
    if (!delta) return;
    if (which === "input") {
      this._inputBuf += delta;
      clearTimeout(this._inputFlushTimer);
      this._inputFlushTimer = setTimeout(() => this._flushTranscript("input", "idle"), TRANSCRIPT_IDLE_MS);
    } else {
      this._outputBuf += delta;
      clearTimeout(this._outputFlushTimer);
      this._outputFlushTimer = setTimeout(() => this._flushTranscript("output", "idle"), TRANSCRIPT_IDLE_MS);
    }
  }

  _flushTranscript(which, reason, finalText) {
    if (which === "input") {
      clearTimeout(this._inputFlushTimer);
      this._inputFlushTimer = null;
      const text = ((finalText && finalText.trim()) || this._inputBuf.trim());
      this._inputBuf = "";
      if (text) {
        const tag = reason === "idle" ? "heard (idle)" : reason === "close" ? "heard (close)" : "heard";
        this._log(`${tag}: "${text}"`);
      }
    } else {
      clearTimeout(this._outputFlushTimer);
      this._outputFlushTimer = null;
      const text = ((finalText && finalText.trim()) || this._outputBuf.trim());
      this._outputBuf = "";
      if (text) {
        const tag = reason === "idle" ? "translated (idle)" : reason === "close" ? "translated (close)" : "translated";
        this._log(`${tag}: "${text}"`);
      }
    }
  }

  _connect() {
    this.ws = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
    });

    this.ws.on("open", () => this._onOpen());
    this.ws.on("message", (raw) => this._onMessage(raw));
    this.ws.on("close", (code) => this._onClose(code));
    this.ws.on("error", (err) => {
      this._log(`WS transport error: ${err.message}`, "error");
    });
  }

  _onOpen() {
    this._log(`Realtime Translations WS connected (model=${config.openaiModel})`);
    this.reconnectAttempts = 0;
    const sessionUpdate = {
      type: "session.update",
      session: {
        audio: {
          input: {
            transcription: { model: "gpt-realtime-whisper" },
            noise_reduction: { type: "near_field" },
          },
          output: {
            language: this.targetLanguage,
          },
        },
      },
    };
    this._log(`session.update sent: ${JSON.stringify(sessionUpdate)}`);
    this._send(sessionUpdate);
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this._log("WS unparseable message", "error");
      return;
    }

    this.eventCounts[msg.type] = (this.eventCounts[msg.type] || 0) + 1;
    this.totalEvents++;
    if (this.totalEvents % 100 === 0) {
      this._log(`events: ${JSON.stringify(this.eventCounts)}`);
    }

    switch (msg.type) {
      case "session.created":
        this._log(`session created: ${msg.session?.id}`);
        break;

      case "session.updated":
        this._log(
          `session configured (source=${this.sourceLanguage || "auto"}, target=${this.targetLanguage}, audioFormat=${this.audioFormat})`
        );
        this.onAudioFormatNegotiated(this.audioFormat);
        this.onReady();
        break;

      case "session.output_audio.delta":
        this.audioDeltasReceived++;
        this.lastOutputAudioAt = Date.now();
        this._logFirst(
          "session.output_audio.delta",
          `first session.output_audio.delta bytes=${(msg.delta || "").length}`
        );
        if (this.audioDeltasReceived % 250 === 0) {
          this._log(`audio out deltas=${this.audioDeltasReceived}`);
        }
        this.onAudioDelta(msg.delta);
        break;

      case "session.output_audio.done":
        break;

      case "session.output_transcript.delta":
        this._appendTranscript("output", msg.delta);
        this.onTranscript(msg.delta, false);
        break;

      case "session.output_transcript.done":
        this._flushTranscript("output", "done", msg.transcript);
        this.onTranscript(msg.transcript, true);
        break;

      case "session.input_transcript.delta":
        this._appendTranscript("input", msg.delta);
        this.onSourceTranscript(msg.delta, false);
        break;

      case "session.input_transcript.done":
        this._flushTranscript("input", "done", msg.transcript);
        this.onSourceTranscript(msg.transcript, true);
        break;

      case "error":
        this._log(`API error: ${JSON.stringify(msg.error)}`, "error");
        this.onError(new Error(msg.error?.message || "OpenAI error"));
        break;

      default:
        if (!this.unknownEventTypes.has(msg.type)) {
          this.unknownEventTypes.add(msg.type);
          this._log(`unhandled event type=${msg.type}`);
        }
        break;
    }
  }

  _onClose(code) {
    if (this.closed) return;

    this._log(`Realtime WS closed unexpectedly (code=${code})`, "warn");

    if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delayMs = RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts);
      this.reconnectAttempts++;
      this._log(`reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delayMs}ms`);
      this.reconnectTimer = setTimeout(() => this._connect(), delayMs);
    } else {
      this._log("reconnect attempts exhausted", "error");
      this.onError(new Error("OpenAI WebSocket reconnect failed after max attempts"));
    }
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /**
   * Stream an audio chunk to OpenAI for translation.
   * @param {string} base64Pcm16 - base64-encoded PCM16 24 kHz audio
   */
  sendAudio(base64Pcm16) {
    this.audioPacketsSent++;
    this.lastInputFrameAt = Date.now();
    if (this.audioPacketsSent === 1) {
      this._log(
        `sending first session.input_audio_buffer.append (bytes=${(base64Pcm16 || "").length})`
      );
    } else if (this.audioPacketsSent % 250 === 0) {
      this._log(`sent ${this.audioPacketsSent} audio packets`);
    }
    this._send({
      type: "session.input_audio_buffer.append",
      audio: base64Pcm16,
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this._flushTranscript("input", "close");
    this._flushTranscript("output", "close");
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}
