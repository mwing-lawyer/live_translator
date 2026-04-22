import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { config } from "./src/config.js";
import { SessionManager } from "./src/sessions/SessionManager.js";
import { TwilioStreamHandler } from "./src/twilio/TwilioStreamHandler.js";
import sessionsRouter from "./src/routes/sessions.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/sessions", sessionsRouter);

const server = http.createServer(app);
const sessionManager = new SessionManager();

// --- Twilio Media Streams WebSocket ---
const wss = new WebSocketServer({ server, path: "/ws/twilio" });

wss.on("connection", (ws, req) => {
  console.log("req", req);
  new TwilioStreamHandler(ws, sessionManager, req);
});

// --- Expose sessionManager for route handlers ---
app.set("sessionManager", sessionManager);

// --- Graceful shutdown ---
function shutdown() {
  console.log("Shutting down...");
  sessionManager.shutdown();
  wss.close();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(config.port, () => {
  console.log(`voice-bridge listening on ${config.port}`);
});
