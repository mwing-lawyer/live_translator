import { TranslationSession } from "./TranslationSession.js";
import { config } from "../config.js";

export class SessionManager {
  constructor() {
    /** @type {Map<string, TranslationSession>} */
    this.sessions = new Map();

    this._orphanTimer = setInterval(
      () => this._cleanOrphans(),
      config.session.orphanCheckIntervalMs,
    );
  }

  /**
   * Join an existing session or create a new one.
   * Returns the TranslationSession instance.
   */
  joinOrCreate(sessionId, role, ws, streamSid, lang) {
    if (!sessionId || !role) {
      console.error("SessionManager: missing sessionId or role in customParameters");
      return null;
    }

    let session = this.sessions.get(sessionId);

    if (!session) {
      session = new TranslationSession(sessionId, () => {
        this.sessions.delete(sessionId);
        console.log(`SessionManager: session ${sessionId} removed (${this.sessions.size} active)`);
      });
      this.sessions.set(sessionId, session);
      console.log(`SessionManager: created session ${sessionId} (${this.sessions.size} active)`);
    }

    session.attachLeg(role, ws, streamSid, lang);
    return session;
  }

  /**
   * Look up a session by ID.
   */
  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Force-end a specific session.
   */
  endSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.destroy();
      return true;
    }
    return false;
  }

  /**
   * List all active sessions (for admin/debug).
   */
  list() {
    return Array.from(this.sessions.values()).map((s) => s.toJSON());
  }

  /**
   * Destroy sessions stuck in "waiting" state beyond the pair timeout.
   */
  _cleanOrphans() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (
        session.state === "waiting" &&
        now - session.createdAt.getTime() > config.session.pairTimeoutMs
      ) {
        console.warn(`SessionManager: orphan session ${id} timed out, destroying`);
        session.destroy();
      }
    }
  }

  /**
   * Shut down the manager (for graceful server shutdown).
   */
  shutdown() {
    clearInterval(this._orphanTimer);
    for (const session of this.sessions.values()) {
      session.destroy();
    }
  }
}
