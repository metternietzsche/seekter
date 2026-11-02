// Local-only CRM and per-application approval console. No external dependencies.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ROOT, allApps, cmdMove, section } from "./seekter.mjs";
import { approvalStatus, decideReview, getReview, reviewId } from "./review.mjs";

const BASE = path.join(ROOT, "dashboard");
const csrf = crypto.randomBytes(32).toString("hex");
const idFor = (row) => {
  try { if (row.url) return reviewId(row.url); } catch { /* older imports may have malformed URLs */ }
  return crypto.createHash("sha256").update(`${row._path}|${row.company}|${row.role}|${row.updated}`).digest("hex");
};

function publicRow(root, row) {
  const id = idFor(row);
  return { id, company: row.company || "", role: row.role || "", status: row.status || "pending",
    url: row.url || "", source: row.source || "", fit: row.fit || "", resume: row.resume || "",
    updated: row.updated || "", applied: row.applied || "", location: row.location_fit || "",
    why: row._body ? section(row._body, "Why it fits") : "",
    notes: row._body ? section(row._body, "Notes") : row.notes || "",
    answers: row._body ? section(row._body, "Answers submitted") : "",
    review: row.status === "pending" ? getReview(root, id) : null,
    approval: row.status === "pending" ? approvalStatus(root, id) : "" };
}

function headers(type) {
  return { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" };
}

function json(res, code, payload) {
  res.writeHead(code, headers("application/json; charset=utf-8"));
  res.end(JSON.stringify(payload));
}

async function body(req) {
  let value = "";
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 8192) throw new Error("Request too large");
  }
  return JSON.parse(value);
}

export function createDashboardServer({ root = ROOT, getRows = allApps, move = cmdMove } = {}) {
  const ordered = () => getRows().sort((a, b) => String(b.applied || b.updated || "").localeCompare(String(a.applied || a.updated || "")));
  return http.createServer(async (req, res) => {
    try {
      if (!/^127\.0\.0\.1:\d+$/.test(String(req.headers.host || ""))) {
        return json(res, 403, { error: "Acceso permitido solo desde 127.0.0.1" });
      }
      const requestUrl = new URL(req.url, "http://localhost");
      const route = requestUrl.pathname;
      if (req.method === "GET" && route === "/api/state") {
        return json(res, 200, { csrf, rows: ordered().map((row) => publicRow(root, row)), generatedAt: new Date().toISOString() });
      }
      if (req.method === "GET" && route.startsWith("/api/cv/")) {
        const id = route.slice("/api/cv/".length);
        const review = getReview(root, id);
        if (!review) return json(res, 404, { error: "CV no encontrado" });
        const candidatePath = path.isAbsolute(review.cv) ? review.cv : path.join(root, review.cv);
        const profileRoot = fs.realpathSync(path.join(root, "profile"));
        const actualPath = fs.realpathSync(candidatePath);
        if (!actualPath.startsWith(profileRoot + path.sep) || path.extname(actualPath).toLowerCase() !== ".pdf") {
          return json(res, 403, { error: "El CV debe ser un PDF en profile/" });
        }
        res.writeHead(200, { ...headers("application/pdf"), "Content-Disposition": "inline" });
        return fs.createReadStream(actualPath).pipe(res);
      }
      if (req.method === "POST" && (route === "/api/decision" || route === "/api/stage")) {
        const origin = req.headers.origin;
        const host = req.headers.host;
        if (origin !== `http://${host}` || req.headers["x-csrf-token"] !== csrf ||
            !String(req.headers["content-type"] || "").startsWith("application/json")) {
          return json(res, 403, { error: "Acción no autorizada" });
        }
        const input = await body(req);
        if (!/^[a-f0-9]{64}$/.test(String(input.id || ""))) return json(res, 400, { error: "Candidatura inválida" });
        const row = ordered().find((item) => idFor(item) === input.id);
        if (!row) return json(res, 404, { error: "Candidatura no encontrada" });
        if (route === "/api/decision") {
          if (row.status !== "pending" || !row.url) return json(res, 409, { error: "Solo se aprueban candidaturas pendientes" });
          if (!["approved", "declined", "revoked"].includes(input.decision)) return json(res, 400, { error: "Decisión inválida" });
          const review = getReview(root, input.id);
          if (!review || review.url !== row.url) return json(res, 409, { error: "Falta una revisión actual de esta oferta" });
          decideReview(root, input.id, input.decision);
          return json(res, 200, { ok: true, approval: approvalStatus(root, input.id) });
        }
        const status = String(input.status || "");
        const note = String(input.note || "").trim();
        if (!["pending", "applied", "interviewing", "offer", "rejected", "closed"].includes(status)) {
          return json(res, 400, { error: "Etapa inválida" });
        }
        if (status === "applied" && row.status === "pending" && !note) {
          return json(res, 400, { error: "Indica cómo se confirmó el envío" });
        }
        move({ target: row._path, status, note });
        return json(res, 200, { ok: true });
      }
      const assets = { "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
        "/inter-regular.woff2": ["../templates/resume/fonts/inter-latin-400-normal.woff2", "font/woff2"],
        "/inter-semibold.woff2": ["../templates/resume/fonts/inter-latin-600-normal.woff2", "font/woff2"] };
      if (req.method === "GET" && assets[route]) {
        const [filename, type] = assets[route];
        res.writeHead(200, headers(type));
        return fs.createReadStream(path.join(BASE, filename)).pipe(res);
      }
      return json(res, 404, { error: "No encontrado" });
    } catch (error) { return json(res, 400, { error: error.message }); }
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 4178;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("Usage: node scripts/dashboard.mjs [--port 4178]");
    process.exit(1);
  }
  const server = createDashboardServer();
  server.on("error", (error) => { console.error(`Cannot start dashboard: ${error.message}`); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`Seekter control: http://127.0.0.1:${server.address().port}`));
}
