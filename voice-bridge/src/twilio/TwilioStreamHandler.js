/**
 * Handles one Twilio Media Stream WebSocket connection.
 * Parses the Twilio protocol events and delegates to the SessionManager.
 */
export class TwilioStreamHandler {
  /**
   * @param {import('ws').WebSocket} ws
   * @param {import('../sessions/SessionManager.js').SessionManager} sessionManager
   */
  constructor(ws, sessionManager, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    console.log("url", url);
    this.urlParams = Object.fromEntries(url.searchParams);
    console.log("urlParams", this.urlParams);
    this.ws = ws;
    this.sm = sessionManager;
    this.streamSid = null;
    this.callSid = null;
    this.session = null;
    this.role = null;

    ws.on("message", (raw) => this._onMessage(raw));
    ws.on("close", () => this._onClose());
    ws.on("error", (err) => console.error("Twilio WS error:", err.message));
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.error("Twilio WS: unparseable message");
      return;
    }

    switch (msg.event) {
      case "connected":
        console.log("Twilio stream connected, protocol:", msg.protocol);
        break;

      case "start": {
        this.streamSid = msg.start.streamSid;
        this.callSid = msg.start.callSid;
        const params = {
          ...this.urlParams,
          ...(msg.start.customParameters || {}),
        };
        this.role = params.role;
        const sessionId = params.sessionId;
        const lang = params.lang;
        console.log("params", this.urlParams);
        console.log(
          `Twilio start: sessionId=${sessionId}, role=${this.role}, lang=${lang}, ` +
          `streamSid=${this.streamSid}, callSid=${this.callSid}`
        );

        this.session = this.sm.joinOrCreate(sessionId, this.role, this.ws, this.streamSid, lang);
        break;
      }

      case "media":
        if (this.session && this.role) {
          this.session.onTwilioAudio(this.role, msg.media.payload);
        }
        break;

      case "stop":
        console.log(`Twilio stop: streamSid=${this.streamSid}`);
        if (this.session) {
          this.session.onLegDisconnected(this.role);
          this.session = null;
        }
        break;

      default:
        break;
    }
  }

  _onClose() {
    console.log(`Twilio WS closed: streamSid=${this.streamSid}`);
    if (this.session) {
      this.session.onLegDisconnected(this.role);
      this.session = null;
    }
  }
}
