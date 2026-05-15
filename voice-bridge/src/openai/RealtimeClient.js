import WebSocket from "ws";
import { config } from "../config.js";

const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime/translations?model=${config.openaiModel}`;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_MS = 1000;
const STALL_THRESHOLD_MS = 5000;

export class RealtimeClient {
  /**
   * @param {object} opts
   * @param {string} opts.targetLanguage - ISO 639-1 code for the output language (e.g. "en", "es")
   * @param {string} [opts.sourceLanguage] - ISO 639-1 code for the source language (used only in log lines)
   * @param {string} [opts.logLabel] - Direction tag prefixed on every log line (e.g. "en->es"). Defaults to targetLanguage.
   * @param {"pcmu" | "pcm16"} [opts.audioFormat] - Currently ignored. The
   *        /v1/realtime/translations endpoint hardcodes PCM16 24 kHz both ways.
   *        Kept for forward compatibility; a "pcmu" request logs a warning and
   *        is treated as "pcm16".
   * @param {(base64Pcm16: string) => void} opts.onAudioDelta - Called per translated audio chunk
   *        (PCM16 24 kHz, base64).
   * @param {(text: string, isFinal: boolean) => void} opts.onTranscript - Called on translated transcript events
   * @param {(text: string, isFinal: boolean) => void} [opts.onSourceTranscript] - Called on source-language transcript events
   * @param {() => void} [opts.onReady] - Called when session is configured and ready
   * @param {(format: "pcmu" | "pcm16") => void} [opts.onAudioFormatNegotiated] - Called when the
   *        effective wire format is known (after possible auto-fallback).
   * @param {(err: Error) => void} [opts.onError] - Called on unrecoverable errors
   */
  constructor(opts) {
    this.opts = opts;
    this.targetLanguage = opts.targetLanguage;
    this.sourceLanguage = opts.sourceLanguage;
    this.logLabel = opts.logLabel || opts.targetLanguage || "?";
    const requestedFormat = opts.audioFormat || config.openaiAudioFormat;
    if (requestedFormat && requestedFormat !== "pcm16") {
      this._log(
        `WARN audioFormat="${requestedFormat}" requested but the ` +
        `/v1/realtime/translations endpoint only supports PCM16 24 kHz. ` +
        `Forcing audioFormat="pcm16".`,
        "warn"
      );
    }
    this.audioFormat = "pcm16";
    this.onAudioDelta = opts.onAudioDelta;
    this.onTranscript = opts.onTranscript;
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
    this._stallReported = false;

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
    this._log(`Realtime Translations WS connected (audioFormat=${this.audioFormat})`);
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
        if (this._stallReported) {
          this._log(`translation resumed after stall`);
          this._stallReported = false;
        }
        this._logFirst(
          "session.output_audio.delta",
          `first output_audio.delta bytes=${(msg.delta || "").length}`
        );
        if (this.audioDeltasReceived % 250 === 0) {
          this._log(`audio out deltas=${this.audioDeltasReceived}`);
        }
        this.onAudioDelta(msg.delta);
        break;

      case "session.output_audio.done":
        break;

      case "session.output_transcript.delta":
        this.onTranscript(msg.delta, false);
        break;

      case "session.output_transcript.done":
        this._log(`translated: "${msg.transcript}"`);
        this.onTranscript(msg.transcript, true);
        break;

      case "session.input_transcript.delta":
        this.onSourceTranscript(msg.delta, false);
        break;

      case "session.input_transcript.done":
        this._log(`heard: "${msg.transcript}"`);
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

    // Stall detection: if we have ever received output audio but none in the
    // last STALL_THRESHOLD_MS while input is still flowing, log once. Resets
    // when a new output_audio.delta arrives.
    if (
      !this._stallReported &&
      this.lastOutputAudioAt > 0 &&
      Date.now() - this.lastOutputAudioAt > STALL_THRESHOLD_MS
    ) {
      const stalledMs = Date.now() - this.lastOutputAudioAt;
      this._log(
        `WARN translation stalled: no output_audio.delta for ${stalledMs}ms ` +
        `while still receiving input frames (audioPacketsSent=${this.audioPacketsSent}, ` +
        `audioDeltasReceived=${this.audioDeltasReceived})`,
        "warn"
      );
      this._stallReported = true;
    }

    this._send({
      type: "session.input_audio_buffer.append",
      audio: base64Pcm16,
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}
