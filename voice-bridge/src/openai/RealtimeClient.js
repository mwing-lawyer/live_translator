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
    const sessionUpdate = {
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
        console.log("OpenAI session configured");
        this.onReady();
        break;

      case "response.created":
        this._logFirst(
          "response.created",
          `OpenAI: response.created id=${msg.response?.id}`
        );
        this.onResponseStart();
        break;

      case "response.audio.delta":
        this._logFirst(
          "response.audio.delta",
          `OpenAI: first audio.delta bytes=${(msg.delta || "").length}`
        );
        this.onAudioDelta(msg.delta);
        break;

      case "response.audio.done":
        break;

      case "response.audio_transcript.delta":
        this.onTranscript(msg.delta, false);
        break;

      case "response.audio_transcript.done":
        console.log(`OpenAI: transcript done "${msg.transcript}"`);
        this.onTranscript(msg.transcript, true);
        break;

      case "response.done":
        this._logFirst(
          "response.done",
          `OpenAI: response.done status=${msg.response?.status}`
        );
        break;

      case "input_audio_buffer.speech_started":
        this._logFirst("speech_started", "OpenAI VAD: speech_started");
        break;

      case "input_audio_buffer.speech_stopped":
        this._logFirst(
          "speech_stopped",
          `OpenAI VAD: speech_stopped (item_id=${msg.item_id})`
        );
        break;

      case "input_audio_buffer.committed":
        this._logFirst("committed", "OpenAI: buffer committed");
        break;

      case "error":
        console.error("OpenAI API error:", JSON.stringify(msg.error));
        this.onError(new Error(msg.error?.message || "OpenAI error"));
        break;

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
   * Stream an audio chunk to OpenAI for translation.
   * @param {string} base64Pcm16 - base64-encoded PCM16 24 kHz audio
   */
  sendAudio(base64Pcm16) {
    this.audioPacketsSent++;
    if (this.audioPacketsSent === 1) {
      console.log(
        `OpenAI: sending first input_audio_buffer.append (bytes=${(base64Pcm16 || "").length})`
      );
    } else if (this.audioPacketsSent % 250 === 0) {
      console.log(`OpenAI: sent ${this.audioPacketsSent} audio packets`);
    }
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
