import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { collectTick, isRegisteredCollectorJob } from "./hydrology";

/** Request-scoped callback: no worker depends on the web process staying alive. */
export async function scheduledHydrology(req: Request, res: Response) {
  let user;
  try { user = await sdk.authenticateRequest(req); }
  catch { res.status(403).json({ error: "cron-only" }); return; }
  try {
    if (!user.isCron || !user.taskUid) { res.status(403).json({ error: "cron-only" }); return; }
    if (!(await isRegisteredCollectorJob(user.taskUid))) { res.json({ ok: true, skipped: "orphan" }); return; }
    res.json({ ok: true, ...(await collectTick()) });
  } catch (error) {
    res.status(500).json({ error: String(error), context: { url: req.path }, timestamp: new Date().toISOString() });
  }
}
