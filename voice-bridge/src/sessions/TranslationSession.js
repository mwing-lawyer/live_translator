import { RealtimeClient } from "../openai/RealtimeClient.js";
import { twilioToOpenAI, openAIToTwilio } from "../audio/codec.js";
import { LegPipeline } from "../audio/legPipeline.js";
import { notify } from "../callbacks/notifier.js";
import { buildTranslationPrompt, voiceFor } from "../openai/translationPrompt.js";
import { config } from "../config.js";

const STATES = {
  WAITING: "waiting",
  ACTIVE: "active",
  CLOSING: "closing",
  CLOSED: "closed",
};

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

    /** Per-leg state: ws, streamSid, ISO language, output pipeline (for this leg's ear). */
    this.legs = {
      caller: { ws: null, streamSid: null, lang: null, pipeline: null },
      rep: { ws: null, streamSid: null, lang: null, pipeline: null },
    };

    /** Translation directions. Format is the wire format negotiated with OpenAI. */
    this.callerToRep = { client: null, format: null }; // caller's mic -> rep's ear
    this.repToCaller = { client: null, format: null }; // rep's mic -> caller's ear

    this._audioCounts = { caller: 0, rep: 0 };
  }

  /**
   * Attach a Twilio Media Stream leg to this session.
   * @param {"caller" | "rep"} role
   * @param {string} lang - ISO 639-1 language code spoken by this leg
   */
  attachLeg(role, ws, streamSid, lang) {
    if (this.state === STATES.CLOSING || this.state === STATES.CLOSED) {
      console.warn(`Session ${this.sessionId}: refusing attach, state=${this.state}`);
      return;
    }

    const leg = this.legs[role];
    if (!leg) {
      console.warn(`Session ${this.sessionId}: unknown role "${role}"`);
      return;
    }

    leg.ws = ws;
    leg.streamSid = streamSid;
    leg.lang = lang || (role === "caller" ? "es" : "en");

    console.log(
      `Session ${this.sessionId}: ${role} leg attached (streamSid=${streamSid}, lang=${leg.lang})`
    );

    // Per-leg output pipeline starts as soon as this leg attaches so the leg
    // hears something (even just original audio from the other side once they
    // arrive). This also drives our bridge-side VAD for soft barge-in.
    leg.pipeline = new LegPipeline({
      ws,
      streamSid,
      role,
      sessionId: this.sessionId,
      onSelfSpeechChange: (isSpeaking) => this._onLegSpeechChange(role, isSpeaking),
    });

    // Pre-warm: open the OpenAI client that produces translated audio FOR this
    // leg's ear (target language is this leg's spoken language). The speaker
    // side may not be present yet; the client just sits ready until audio arrives.
    this._ensureClientForListener(role);

    const otherRole = role === "caller" ? "rep" : "caller";
    if (this.legs[otherRole].ws) {
      this._ensureClientForListener(otherRole);

      // Push the now-known source language into the direction that was
      // pre-warmed back when this leg wasn't attached yet (it was opened with
      // sourceLanguage="auto"). The pre-warmed direction is the one whose
      // SOURCE is THIS just-attached leg.
      const preWarmedDirKey = role === "caller" ? "callerToRep" : "repToCaller";
      this[preWarmedDirKey].client?.setSourceLanguage(leg.lang);

      if (this.state === STATES.WAITING) {
        this.state = STATES.ACTIVE;
        console.log(
          `Session ${this.sessionId}: both legs paired, translation active ` +
          `(${this.legs.caller.lang}->${this.legs.rep.lang} / ` +
          `${this.legs.rep.lang}->${this.legs.caller.lang})`
        );
      }
    }
  }

  /**
   * Ensure the RealtimeClient that produces audio FOR `listenerRole` exists.
   * The listener leg must be attached (we need its language as the output
   * target). The speaker leg may or may not be attached yet; OpenAI auto-detects
   * the source language so the speaker's lang is only used for log lines.
   */
  _ensureClientForListener(listenerRole) {
    const listenerLeg = this.legs[listenerRole];
    if (!listenerLeg?.lang || !listenerLeg.pipeline) return;

    const speakerRole = listenerRole === "rep" ? "caller" : "rep";
    const directionKey = speakerRole === "caller" ? "callerToRep" : "repToCaller";
    const slot = this[directionKey];
    if (slot.client) return;

    const speakerLang = this.legs[speakerRole]?.lang;
    const targetLang = listenerLeg.lang;
    const dirLabel = `${speakerLang || "auto"}->${targetLang}`;

    console.log(
      `Session ${this.sessionId}: opening ${directionKey} (${dirLabel}) ` +
      `(pre-warm on ${listenerRole}-attach)`
    );

    slot.client = new RealtimeClient({
      sourceLanguage: speakerLang || undefined,
      targetLanguage: targetLang,
      instructions: buildTranslationPrompt(speakerLang || "auto", targetLang),
      voice: voiceFor(targetLang),
      audioFormat: config.openaiAudioFormat,
      logLabel: dirLabel,
      onAudioFormatNegotiated: (fmt) => {
        slot.format = fmt;
        console.log(
          `Session ${this.sessionId}: ${directionKey} audio format negotiated -> ${fmt}`
        );
      },
      onAudioDelta: (b64) => {
        // g711_ulaw passthrough straight to Twilio; pcm16 needs to be resampled to mulaw 8 kHz first.
        const mulaw = slot.format === "pcm16" ? openAIToTwilio(b64) : b64;
        listenerLeg.pipeline?.pushTranslated(mulaw);
      },
      onTranscript: (text, isFinal) => {
        notify(this.sessionId, speakerRole, dirLabel, text, isFinal);
      },
      onError: (err) => {
        console.error(`Session ${this.sessionId} ${dirLabel} error:`, err.message);
      },
    });
  }

  /**
   * Called when a Twilio media frame arrives from a leg.
   */
  onTwilioAudio(role, base64Mulaw) {
    if (this.state === STATES.CLOSING || this.state === STATES.CLOSED) return;

    const leg = this.legs[role];
    if (!leg) return;

    this._audioCounts[role] = (this._audioCounts[role] || 0) + 1;
    const n = this._audioCounts[role];
    if (n === 1) {
      console.log(`Session ${this.sessionId}: first audio frame from ${role}`);
    } else if (n % 500 === 0) {
      console.log(`Session ${this.sessionId}: ${role} forwarded ${n} frames`);
    }

    // Drive bridge-side VAD on this leg's own mic.
    leg.pipeline?.pushOwnMic(base64Mulaw);

    // Send to OpenAI for translation. g711_ulaw is a passthrough; pcm16 needs to be
    // resampled from Twilio's mulaw 8 kHz up to PCM16 24 kHz first.
    const directionKey = role === "caller" ? "callerToRep" : "repToCaller";
    const slot = this[directionKey];
    if (slot.client) {
      const audio = slot.format === "pcm16" ? twilioToOpenAI(base64Mulaw) : base64Mulaw;
      slot.client.sendAudio(audio);
    }
  }

  _onLegSpeechChange(role, isSpeaking) {
    if (!isSpeaking) return;
    if (!config.bargeInHardCut) return;
    // Hard barge-in: drop the translated audio queued for this leg's ear so the
    // listener can hear themselves immediately. Soft barge-in (just ducking)
    // happens inside LegPipeline regardless of this flag.
    this.legs[role]?.pipeline?.clearTranslated();
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

    this.callerToRep.client?.close();
    this.repToCaller.client?.close();
    this.callerToRep.client = null;
    this.repToCaller.client = null;

    for (const role of ["caller", "rep"]) {
      const leg = this.legs[role];
      leg.pipeline?.close();
      leg.pipeline = null;
      if (leg.ws?.readyState === 1) leg.ws.close();
      leg.ws = null;
    }

    this.state = STATES.CLOSED;
    this.onDestroyed();
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      state: this.state,
      createdAt: this.createdAt.toISOString(),
      callerLang: this.legs.caller.lang,
      repLang: this.legs.rep.lang,
      callerStreamSid: this.legs.caller.streamSid,
      repStreamSid: this.legs.rep.streamSid,
      hasCallerLeg: this.legs.caller.ws !== null,
      hasRepLeg: this.legs.rep.ws !== null,
      hasCallerToRepClient: this.callerToRep.client !== null,
      hasRepToCallerClient: this.repToCaller.client !== null,
      audioFormatCallerToRep: this.callerToRep.format,
      audioFormatRepToCaller: this.repToCaller.format,
    };
  }
}
