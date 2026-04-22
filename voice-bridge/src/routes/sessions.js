import { Router } from "express";

const router = Router();

/**
 * GET /sessions -- list all active translation sessions.
 */
router.get("/", (req, res) => {
  const sm = req.app.get("sessionManager");
  res.json({ sessions: sm.list() });
});

/**
 * GET /sessions/:id -- get a single session's details.
 */
router.get("/:id", (req, res) => {
  const sm = req.app.get("sessionManager");
  const session = sm.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  res.json(session.toJSON());
});

/**
 * POST /sessions/:id/end -- force-teardown a session.
 */
router.post("/:id/end", (req, res) => {
  const sm = req.app.get("sessionManager");
  const ended = sm.endSession(req.params.id);
  if (!ended) {
    return res.status(404).json({ error: "Session not found" });
  }
  res.json({ ok: true, sessionId: req.params.id });
});

export default router;
