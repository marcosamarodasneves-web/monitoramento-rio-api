import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { collectTick, getForecasts, getHistory, getSnapshot, registerAccess } from "../hydrology";
import { scheduledHydrology } from "../scheduled-hydrology";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  app.post("/api/scheduled/hydrology", scheduledHydrology);
  app.get("/api/hydrology/snapshot", async (_req, res) => {
    try { res.json(await getSnapshot()); } catch (error) { res.status(503).json({ error: "hydrology_unavailable", message: String(error) }); }
  });
  app.get("/api/hydrology/history", async (req, res) => {
    const days = Number(req.query.days ?? 1);
    if (!Number.isFinite(days) || days < 1 || days > 60) { res.status(400).json({ error: 'invalid_history_parameters' }); return; }
    try { res.json(await getHistory(days)); } catch (error) { res.status(503).json({ error: "hydrology_unavailable", message: String(error) }); }
  });
  app.get("/api/hydrology/forecasts", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const bridge = typeof req.query.bridge === "string" ? req.query.bridge : undefined;
    const hours = Number(req.query.hours ?? 24);
    if ((bridge && !["dom-tito", "br-470", "ricardo-kanitz"].includes(bridge)) || !Number.isFinite(hours) || hours < 1 || hours > 1440) {
      res.status(400).json({ error: "invalid_forecast_parameters" }); return;
    }
    try { res.json(await getForecasts(bridge, hours)); } catch (error) { res.status(503).json({ error: "hydrology_unavailable", message: String(error) }); }
  });
  app.post("/api/hydrology/access", async (req, res) => {
    try { res.json(await registerAccess(req.body?.kind === "app" ? "app" : "api")); } catch (error) { res.status(503).json({ error: "hydrology_unavailable", message: String(error) }); }
  });
  app.post("/api/hydrology/collect", async (req, res) => {
    const expected = process.env.COLLECTOR_SECRET;
    if (!expected || req.get("x-collector-secret") !== expected) { res.status(401).json({ error: "unauthorized" }); return; }
    try { res.json(await collectTick()); } catch (error) { res.status(503).json({ error: "collection_failed", message: String(error) }); }
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
