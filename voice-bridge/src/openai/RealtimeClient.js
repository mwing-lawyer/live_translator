import WebSocket from "ws";
import { config } from "../config.js";

const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${config.openaiModel}`;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_MS = 1000;

export class RealtimeClient {
  /**
   * @param {object} opts
   * @param {string} opts.instructions - System prompt for this translation direction
   * @param {(base64Pcm: string) => void} opts.onAudioDelta - Called per translated audio chunk
   * @param {(text: string, isFinal: boolean) => void} opts.onTranscript - Called on transcript events
   * @param {() => void} [opts.onReady] - Called when session is configured and ready
   * @param {() => void} [opts.onResponseStart] - Called when a new translation response begins
   * @param {(err: Error) => void} [opts.onError] - Called on unrecoverable errors
   */
  constructor(opts) {
    this.opts = opts;
    this.instructions = opts.instructions;
    this.onAudioDelta = opts.onAudioDelta;
    this.onTranscript = opts.onTranscript;
    this.onReady = opts.onReady || (() => {});
    this.onResponseStart = opts.onResponseStart || (() => {});
    this.onError = opts.onError || ((err) => console.error("RealtimeClient error:", err));

    this.closed = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.ws = null;

    this._connect();
  }

  _connect() {
    this.ws = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    this.ws.on("open", () => this._onOpen());
    this.ws.on("message", (raw) => this._onMessage(raw));
    this.ws.on("close", (code) => this._onClose(code));
    this.ws.on("error", (err) => {
      console.error("OpenAI WS transport error:", err.message);
    });
  }

  _onOpen() {
    console.log("OpenAI Realtime WS connected");
    this.reconnectAttempts = 0;
    this._send({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions: this.instructions,
        voice: "alloy",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: config.vad.threshold,
          prefix_padding_ms: config.vad.prefixPaddingMs,
          silence_duration_ms: config.vad.silenceDurationMs,
        },
      },
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.error("OpenAI WS: unparseable message");
      return;
    }

    switch (msg.type) {
      case "session.created":
        console.log("OpenAI session created:", msg.session?.id);
        break;

      case "session.updated":
        console.log("OpenAI session configured");
        this.onReady();
        break;

      case "response.created":
        this.onResponseStart();
        break;

      case "response.audio.delta":
        this.onAudioDelta(msg.delta);
        break;

      case "response.audio.done":
        break;

      case "response.audio_transcript.delta":
        this.onTranscript(msg.delta, false);
        break;

      case "response.audio_transcript.done":
        this.onTranscript(msg.transcript, true);
        break;

      case "input_audio_buffer.speech_started":
        break;

      case "input_audio_buffer.speech_stopped":
        break;

      case "error":
        console.error("OpenAI API error:", JSON.stringify(msg.error));
        this.onError(new Error(msg.error?.message || "OpenAI error"));
        break;

      default:
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
   * Stream an audio chunk to OpenAI for translation.
   * @param {string} base64Pcm16 - base64-encoded PCM16 24 kHz audio
   */
  sendAudio(base64Pcm16) {
    this._send({
      type: "input_audio_buffer.append",
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
