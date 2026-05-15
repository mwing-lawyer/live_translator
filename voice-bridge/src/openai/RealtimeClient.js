import WebSocket from "ws";
import { config } from "../config.js";

const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${config.openaiModel}`;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_MS = 1000;
const STALL_THRESHOLD_MS = 5000;
const TRANSCRIPT_IDLE_MS = 1200;

export class RealtimeClient {
  /**
   * @param {object} opts
   * @param {string} opts.targetLanguage - ISO 639-1 code for the output language (e.g. "en", "es")
   * @param {string} [opts.sourceLanguage] - ISO 639-1 code for the source language (used in log lines and prompt)
   * @param {string} opts.instructions - System prompt for the model (translation instructions)
   * @param {string} opts.voice - Voice id (e.g. "verse", "alloy", "echo")
   * @param {"g711_ulaw" | "pcm16"} [opts.audioFormat] - Wire format for audio in/out. Default from config.
   * @param {string} [opts.logLabel] - Direction tag prefixed on every log line (e.g. "en->es"). Defaults to targetLanguage.
   * @param {(b64Audio: string) => void} opts.onAudioDelta - Called per translated audio chunk (mulaw 8 kHz if g711_ulaw, PCM16 24 kHz if pcm16).
   * @param {(text: string, isFinal: boolean) => void} opts.onTranscript - Called on translated transcript events
   * @param {(text: string, isFinal: boolean) => void} [opts.onSourceTranscript] - Called on source-language transcript events
   * @param {() => void} [opts.onReady] - Called when session is configured and ready
   * @param {(format: "g711_ulaw" | "pcm16") => void} [opts.onAudioFormatNegotiated] - Called when the effective wire format is known
   * @param {(err: Error) => void} [opts.onError] - Called on unrecoverable errors
   */
  constructor(opts) {
    this.opts = opts;
    this.targetLanguage = opts.targetLanguage;
    this.sourceLanguage = opts.sourceLanguage;
    this.logLabel = opts.logLabel || opts.targetLanguage || "?";
    this.instructions = opts.instructions || "";
    this.voice = opts.voice || config.openaiVoice;
    this.audioFormat = opts.audioFormat || config.openaiAudioFormat;
    if (this.audioFormat !== "g711_ulaw" && this.audioFormat !== "pcm16") {
      this._log(`WARN unknown audioFormat="${this.audioFormat}", forcing "g711_ulaw"`, "warn");
      this.audioFormat = "g711_ulaw";
    }

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
    this._lastTurnCommittedAt = 0;
    this._stallReported = false;

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

  /**
   * Push a source-language hint into an already-open session. Useful when the
   * client was pre-warmed before the speaker leg attached (sourceLanguage="auto"),
   * and we now know what language to expect.
   */
  setSourceLanguage(lang) {
    if (!lang || lang === "auto" || lang === this.sourceLanguage) return;
    this.sourceLanguage = lang;
    this.logLabel = `${lang}->${this.targetLanguage}`;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._send({
        type: "session.update",
        session: {
          audio: {
            input: {
              transcription: { model: "gpt-realtime-whisper", language: lang },
            },
          },
        },
      });
      this._log(`source language updated to "${lang}"`);
    }
  }

  _audioFormatBlock() {
    return this.audioFormat === "g711_ulaw"
      ? { type: "audio/pcmu" }
      : { type: "audio/pcm", rate: 24000 };
  }

  _onOpen() {
    this._log(`Realtime WS connected (model=${config.openaiModel}, audioFormat=${this.audioFormat}, voice=${this.voice})`);
    this.reconnectAttempts = 0;
    const transcription = { model: "gpt-realtime-whisper" };
    if (this.sourceLanguage && this.sourceLanguage !== "auto") {
      transcription.language = this.sourceLanguage;
    }
    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        model: config.openaiModel,
        output_modalities: ["audio"],
        instructions: this.instructions,
        audio: {
          input: {
            format: this._audioFormatBlock(),
            transcription,
            noise_reduction: { type: "near_field" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: config.turnDetectionSilenceMs,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: this._audioFormatBlock(),
            voice: this.voice,
          },
        },
      },
    };
    this._log(
      `session.update sent (instructions=${this.instructions.length} chars, ` +
      `silence_duration_ms=${config.turnDetectionSilenceMs}, ` +
      `transcription.language=${transcription.language || "auto"})`
    );
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
          `session configured (source=${this.sourceLanguage || "auto"}, target=${this.targetLanguage}, ` +
          `audioFormat=${this.audioFormat}, voice=${this.voice})`
        );
        this.onAudioFormatNegotiated(this.audioFormat);
        this.onReady();
        break;

      case "response.created":
        this._logFirst("response.created", `first response.created id=${msg.response?.id}`);
        break;

      case "response.done":
        // Not chatty per response; the heard/translated lines tell the story.
        break;

      case "response.output_audio.delta":
        this.audioDeltasReceived++;
        this.lastOutputAudioAt = Date.now();
        this._lastTurnCommittedAt = 0;
        if (this._stallReported) {
          this._log(`translation resumed after stall`);
          this._stallReported = false;
        }
        this._logFirst(
          "response.output_audio.delta",
          `first response.output_audio.delta bytes=${(msg.delta || "").length}`
        );
        if (this.audioDeltasReceived % 250 === 0) {
          this._log(`audio out deltas=${this.audioDeltasReceived}`);
        }
        this.onAudioDelta(msg.delta);
        break;

      case "response.output_audio.done":
        break;

      case "response.output_audio_transcript.delta":
        this._appendTranscript("output", msg.delta);
        this.onTranscript(msg.delta, false);
        break;

      case "response.output_audio_transcript.done":
        this._flushTranscript("output", "done", msg.transcript);
        this.onTranscript(msg.transcript, true);
        break;

      case "conversation.item.input_audio_transcription.delta":
        this._appendTranscript("input", msg.delta);
        this.onSourceTranscript(msg.delta, false);
        break;

      case "conversation.item.input_audio_transcription.completed":
        this._flushTranscript("input", "done", msg.transcript);
        this.onSourceTranscript(msg.transcript, true);
        break;

      case "conversation.item.input_audio_transcription.failed":
        this._log(`input transcription failed: ${JSON.stringify(msg.error)}`, "warn");
        break;

      case "input_audio_buffer.speech_started":
        this._logFirst("input_audio_buffer.speech_started", `first speech_started`);
        break;

      case "input_audio_buffer.speech_stopped":
        this._logFirst("input_audio_buffer.speech_stopped", `first speech_stopped`);
        break;

      case "input_audio_buffer.committed":
        // Server VAD committed a turn; create_response: true will trigger a response next.
        this._lastTurnCommittedAt = Date.now();
        break;

      case "conversation.item.added":
      case "conversation.item.done":
      case "response.output_item.added":
      case "response.output_item.done":
      case "response.content_part.added":
      case "response.content_part.done":
        // GA conversation/response lifecycle events we observe but do not act on.
        break;

      case "rate_limits.updated":
        // Periodic rate limit info; ignore.
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
   * @param {string} b64Audio - base64-encoded audio in the negotiated format
   *        (mulaw 8 kHz when audioFormat === "g711_ulaw", PCM16 24 kHz when "pcm16")
   */
  sendAudio(b64Audio) {
    this.audioPacketsSent++;
    this.lastInputFrameAt = Date.now();
    if (this.audioPacketsSent === 1) {
      this._log(
        `sending first input_audio_buffer.append (bytes=${(b64Audio || "").length}, format=${this.audioFormat})`
      );
    } else if (this.audioPacketsSent % 250 === 0) {
      this._log(`sent ${this.audioPacketsSent} audio packets`);
    }

    if (
      !this._stallReported &&
      this._lastTurnCommittedAt > 0 &&
      Date.now() - this._lastTurnCommittedAt > STALL_THRESHOLD_MS
    ) {
      const stalledMs = Date.now() - this._lastTurnCommittedAt;
      this._log(
        `WARN translation stalled: turn committed ${stalledMs}ms ago but no ` +
        `response.output_audio.delta yet (audioDeltasReceived=${this.audioDeltasReceived})`,
        "warn"
      );
      this._stallReported = true;
    }

    this._send({
      type: "input_audio_buffer.append",
      audio: b64Audio,
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
