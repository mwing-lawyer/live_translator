import { config } from "../config.js";

/**
 * POST a transcript event to the PHP callback URL.
 * Fire-and-forget -- never blocks the audio pipeline.
 *
 * @param {string} sessionId
 * @param {string} role       - "caller" | "rep"
 * @param {string} direction  - "es-en" | "en-es"
 * @param {string} text
 * @param {boolean} isFinal
 */
export async function notify(sessionId, role, direction, text, isFinal) {
  if (!config.callbackUrl) return;

  const url = `${config.callbackUrl}/api/bridge/transcript`;
  const body = JSON.stringify({
    sessionId,
    role,
    direction,
    text,
    isFinal,
    timestamp: new Date().toISOString(),
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`Notifier: ${res.status} from ${url}`);
    }
  } catch (err) {
    console.warn(`Notifier: failed to reach ${url} -- ${err.message}`);
  }
}
