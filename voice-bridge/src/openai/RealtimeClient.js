import WebSocket from "ws";
import { config } from "../config.js";

const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime/translations?model=${config.openaiModel}`;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_MS = 1000;

export class RealtimeClient {
  /**
   * @param {object} opts
   * @param {string} opts.targetLanguage - ISO 639-1 code for the output language (e.g. "en", "es")
   * @param {string} [opts.sourceLanguage] - ISO 639-1 code for the source language (used only in log lines)
   * @param {"pcmu" | "pcm16"} [opts.audioFormat] - Audio codec to use on the OpenAI link.
   *        "pcmu" means raw mulaw 8 kHz both directions (matches Twilio, no resample).
   *        "pcm16" means PCM16 24 kHz (Twilio audio must be resampled by caller).
   *        Defaults to config.openaiAudioFormat.
   * @param {(base64Audio: string) => void} opts.onAudioDelta - Called per translated audio chunk.
   *        With audioFormat="pcmu" the payload is mulaw 8 kHz; with "pcm16" it is PCM16 24 kHz.
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
    this.audioFormat = opts.audioFormat || config.openaiAudioFormat;
    this.onAudioDelta = opts.onAudioDelta;
    this.onTranscript = opts.onTranscript;
    this.onSourceTranscript = opts.onSourceTranscript || (() => {});
    this.onReady = opts.onReady || (() => {});
    this.onAudioFormatNegotiated = opts.onAudioFormatNegotiated || (() => {});
    this.onError = opts.onError || ((err) => console.error("RealtimeClient error:", err));

    this.closed = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.ws = null;
    this._fellBackToPcm16 = false;

    this.eventCounts = {};
    this.totalEvents = 0;
    this.unknownEventTypes = new Set();
    this.firstSeen = new Set();
    this.audioPacketsSent = 0;

    this._connect();
  }

  _logFirst(key, message) {
    if (this.firstSeen.has(key)) return;
    this.firstSeen.add(key);
    console.log(message);
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
      console.error("OpenAI WS transport error:", err.message);
    });
  }

  _formatBlock() {
    return this.audioFormat === "pcmu"
      ? { type: "audio/pcmu" }
      : { type: "audio/pcm", rate: 24000 };
  }

  _onOpen() {
    console.log(`OpenAI Realtime Translations WS connected (audioFormat=${this.audioFormat})`);
    this.reconnectAttempts = 0;
    const fmt = this._formatBlock();
    const sessionUpdate = {
      type: "session.update",
      session: {
        audio: {
          input: {
            format: fmt,
            transcription: { model: "gpt-realtime-whisper" },
            noise_reduction: { type: "near_field" },
          },
          output: {
            format: fmt,
            language: this.targetLanguage,
          },
        },
      },
    };
    console.log(`OpenAI session.update sent: ${JSON.stringify(sessionUpdate)}`);
    this._send(sessionUpdate);
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.error("OpenAI WS: unparseable message");
      return;
    }

    this.eventCounts[msg.type] = (this.eventCounts[msg.type] || 0) + 1;
    this.totalEvents++;
    if (this.totalEvents % 100 === 0) {
      console.log(`OpenAI events: ${JSON.stringify(this.eventCounts)}`);
    }

    switch (msg.type) {
      case "session.created":
        console.log("OpenAI session created:", msg.session?.id);
        break;

      case "session.updated":
        console.log(
          `OpenAI session configured (source=${this.sourceLanguage || "auto"}, target=${this.targetLanguage}, audioFormat=${this.audioFormat})`
        );
        this.onAudioFormatNegotiated(this.audioFormat);
        this.onReady();
        break;

      case "session.output_audio.delta":
        this._logFirst(
          "session.output_audio.delta",
          `OpenAI: first output_audio.delta bytes=${(msg.delta || "").length}`
        );
        this.onAudioDelta(msg.delta);
        break;

      case "session.output_audio.done":
        break;

      case "session.output_transcript.delta":
        this.onTranscript(msg.delta, false);
        break;

      case "session.output_transcript.done":
        console.log(`OpenAI: output transcript done "${msg.transcript}"`);
        this.onTranscript(msg.transcript, true);
        break;

      case "session.input_transcript.delta":
        this.onSourceTranscript(msg.delta, false);
        break;

      case "session.input_transcript.done":
        this._logFirst(
          "session.input_transcript.done",
          `OpenAI: input transcript done "${msg.transcript}"`
        );
        this.onSourceTranscript(msg.transcript, true);
        break;

      case "error": {
        const err = msg.error || {};
        const param = err.param || "";
        const isFormatRejection =
          err.code === "unknown_parameter" &&
          /audio\.(input|output)\.format/.test(param);
        if (isFormatRejection && this.audioFormat === "pcmu" && !this._fellBackToPcm16) {
          console.warn(
            `OpenAI rejected audio.*.format=pcmu (${param}); falling back to pcm16 and reconnecting`
          );
          this._fellBackToPcm16 = true;
          this.audioFormat = "pcm16";
          this.audioPacketsSent = 0;
          this.eventCounts = {};
          this.totalEvents = 0;
          this.firstSeen = new Set();
          this.unknownEventTypes = new Set();
          if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
            this.ws.removeAllListeners();
            this.ws.close();
          }
          this._connect();
          return;
        }
        console.error("OpenAI API error:", JSON.stringify(msg.error));
        this.onError(new Error(err.message || "OpenAI error"));
        break;
      }

      default:
        if (!this.unknownEventTypes.has(msg.type)) {
          this.unknownEventTypes.add(msg.type);
          console.log(`OpenAI: unhandled event type=${msg.type}`);
        }
        break;
    }
  }

  _onClose(code) {
    if (this.closed) return;

    console.warn(`OpenAI Realtime WS closed unexpectedly (code=${code})`);

    if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delayMs = RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts);
      this.reconnectAttempts++;
      console.log(`OpenAI reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delayMs}ms`);
      this.reconnectTimer = setTimeout(() => this._connect(), delayMs);
    } else {
      console.error("OpenAI reconnect attempts exhausted");
      this.onError(new Error("OpenAI WebSocket reconnect failed after max attempts"));
    }
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /**
   * Stream an audio chunk to OpenAI for translation. The encoding must match
   * this client's effective `audioFormat`: mulaw 8 kHz for "pcmu", PCM16 24 kHz for "pcm16".
   * @param {string} base64Audio
   */
  sendAudio(base64Audio) {
    this.audioPacketsSent++;
    if (this.audioPacketsSent === 1) {
      console.log(
        `OpenAI: sending first session.input_audio_buffer.append (bytes=${(base64Audio || "").length}, format=${this.audioFormat})`
      );
    } else if (this.audioPacketsSent % 250 === 0) {
      console.log(`OpenAI: sent ${this.audioPacketsSent} audio packets`);
    }
    this._send({
      type: "session.input_audio_buffer.append",
      audio: base64Audio,
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
