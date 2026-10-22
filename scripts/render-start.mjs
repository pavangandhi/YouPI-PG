/**
 * Render.com production supervisor for YOUPI PG.
 *
 * WHY THIS EXISTS
 * ---------------
 * Render exposes exactly one public port per web service, but the gateway needs
 * two long-lived processes:
 *
 *   - Payment Core API  (PAYMENT_API_PORT, default 6100) - state machine, webhooks
 *   - Checkout Portal   (public)                          - customer-facing UI + /youpi.js
 *
 * The Checkout Portal proxies every `/api/*` request to the Payment API on
 * 127.0.0.1, so a single public port serves the entire customer journey:
 * the checkout page, the SDK, and the merchant API surface.
 *
 * `npm start` (scripts/start.js) is deliberately NOT used here. It forces
 * production mode and launches a Cloudflare Tunnel, which conflicts with
 * Render's own managed TLS and public hostname. Render already terminates TLS
 * and routes HTTPS to one port, so the tunnel is unnecessary.
 *
 * ENVIRONMENT
 * -----------
 *   PORT                  public port Render routes to (default 10000)
 *   PAYMENT_API_PORT      internal API port (default 6100)
 *   YOUPI_BIND_HOST       bind address for public-facing services (0.0.0.0 here)
 *   BASE_CHECKOUT_URL     public checkout origin, e.g. https://pay.vasttudevo.com
 *   BASE_PAYMENT_API_URL  public API origin; defaults to BASE_CHECKOUT_URL so the
 *                         browser SDK and the portal proxy stay on one origin
 *
 * Secrets (ENCRYPTION_MASTER_KEY, JWT_SECRET, INTERNAL_SERVICE_TOKEN,
 * ADMIN_API_TOKEN, OBSERVER_API_TOKEN, COIN_STORE_WEBHOOK_SECRET,
 * ANDROID_ENROLLMENT_SECRET) are read from the environment only. They are never
 * auto-generated here: on an ephemeral filesystem a generated secret would
 * change on every deploy and silently break webhook signatures.
 */

import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const PUBLIC_PORT = Number(process.env.PORT || 10000);
const API_PORT = Number(process.env.PAYMENT_API_PORT || 6100);

process.env.YOUPI_MODE = "production";
process.env.NODE_ENV = "production";
// The public-facing process must accept Render's proxy, not just loopback.
process.env.YOUPI_BIND_HOST = process.env.YOUPI_BIND_HOST || "0.0.0.0";
process.env.CHECKOUT_PORTAL_PORT = String(PUBLIC_PORT);
process.env.PAYMENT_API_PORT = String(API_PORT);

// One origin for everything the browser touches. The portal proxies /api/* to
// the internal API, so pointing both at the public checkout host keeps the
// SDK, the checkout page and the API on the same site.
if (!process.env.BASE_PAYMENT_API_URL && process.env.BASE_CHECKOUT_URL) {
  process.env.BASE_PAYMENT_API_URL = process.env.BASE_CHECKOUT_URL;
}

const SERVICES = [
  {
    id: "payment-api",
    script: path.join(rootDir, "apps/payment-api/src/index.js"),
    env: { PAYMENT_API_PORT: String(API_PORT) },
  },
  {
    id: "checkout-portal",
    script: path.join(rootDir, "apps/checkout-portal/src/index.js"),
    env: { CHECKOUT_PORTAL_PORT: String(PUBLIC_PORT) },
  },
];

const children = new Map();
let shuttingDown = false;

function log(service, message) {
  console.log(`[${service}] ${message}`);
}

function start(service) {
  if (shuttingDown) return;

  const child = fork(service.script, [], {
    cwd: rootDir,
    env: { ...process.env, ...service.env },
    stdio: "inherit",
  });
  children.set(service.id, child);

  child.on("exit", (code, signal) => {
    children.delete(service.id);
    if (shuttingDown) return;
    log(service.id, `exited (code=${code} signal=${signal}) — restarting in 3s`);
    setTimeout(() => start(service), 3000);
  });

  log(service.id, `started (pid ${child.pid})`);
}

console.log("====================================================");
console.log("🚀 YOUPI PG — Render supervisor");
console.log("====================================================");
console.log(`  Public port : ${PUBLIC_PORT} (Checkout Portal)`);
console.log(`  Internal API: ${API_PORT} (loopback only)`);
console.log(`  Checkout URL: ${process.env.BASE_CHECKOUT_URL || "(not set)"}`);
console.log("----------------------------------------------------");

for (const service of SERVICES) start(service);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[supervisor] ${signal} received — stopping services`);
  for (const child of children.values()) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  console.error("[supervisor] uncaught exception:", err);
});
