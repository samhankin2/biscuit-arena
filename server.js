/**
 * Arnott's Biscuit Arena — zero-dependency Node server.
 * - static frontend from ./public
 * - JSON API backed by SQLite (node:sqlite)
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = resolve(__dirname, "public");
const CONFIG_DIR = resolve(process.env.CONFIG_DIR || join(__dirname, "data"));
const DATA_DIR = resolve(process.env.DATA_DIR || join(__dirname, "data"));
const DB_PATH = join(DATA_DIR, "arena.db");

mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- config
const config = JSON.parse(readFileSync(join(CONFIG_DIR, "config.json"), "utf8"));

// ---------------------------------------------------------------- database
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS biscuits (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS stations (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT NOT NULL,
    name       TEXT NOT NULL,
    email      TEXT,
    comment    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ratings (
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    biscuit_id    TEXT NOT NULL,
    score         INTEGER NOT NULL,
    comment       TEXT,
    PRIMARY KEY (submission_id, biscuit_id)
  );
`);

const seedBiscuits = db.prepare(
  "INSERT INTO biscuits (id, name, emoji, sort) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET name = excluded.name, emoji = excluded.emoji, sort = excluded.sort",
);
const seedStations = db.prepare(
  "INSERT INTO stations (code, name) VALUES (?, ?) " +
    "ON CONFLICT(code) DO UPDATE SET name = excluded.name",
);
db.exec("BEGIN");
config.biscuits.forEach((b, i) => seedBiscuits.run(b.id, b.name, b.emoji ?? "", i));
(config.stations || []).forEach((s) => seedStations.run(s.code, s.name));
db.exec("COMMIT");

const allBiscuits = db.prepare("SELECT id, name, emoji FROM biscuits ORDER BY sort").all();
const allStations = db.prepare("SELECT code, name FROM stations").all();

// ---------------------------------------------------------------- helpers
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("Payload too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Accepts "TABLE-01", "arena:TABLE-01", "ARNOTTS://TABLE-01" etc. */
function normaliseCode(raw) {
  if (!raw) return "";
  let code = String(raw).trim();
  const idx = code.lastIndexOf(":");
  if (idx > -1 && code.length - idx - 1 <= 32) code = code.slice(idx + 1);
  code = code.replace(/[^A-Za-z0-9_-]/g, "").toUpperCase();
  return code;
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = resolve(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== PUBLIC_DIR) {
    return sendJson(res, 403, { ok: false, error: "Forbidden" });
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) return serveStatic(req, res, join(rel, "index.html"));
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

// ---------------------------------------------------------------- api
async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, submissions: countSubmissions() });
  }

  if (pathname === "/api/config" && method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      title: config.title,
      subtitle: config.subtitle,
      biscuits: allBiscuits,
      stations: allStations,
    });
  }

  if (pathname === "/api/form" && method === "GET") {
    const code = normaliseCode(url.searchParams.get("code"));
    const station = allStations.find((s) => s.code === code);
    return sendJson(res, 200, {
      ok: true,
      station: station ?? { code: code || "UNSCANNED", name: "Walk-in entry" },
      biscuits: allBiscuits,
    });
  }

  if (pathname === "/api/submissions" && method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: String(err.message || err) });
    }
    const name = String(body.name || "").trim();
    const code = normaliseCode(body.code);
    const ratings = Array.isArray(body.ratings) ? body.ratings : [];
    if (!name) return sendJson(res, 400, { ok: false, error: "Please enter your name" });
    if (!ratings.length) return sendJson(res, 400, { ok: false, error: "No ratings submitted" });

    const validIds = new Set(allBiscuits.map((b) => b.id));
    const clean = ratings
      .map((r) => ({
        id: String(r.id || ""),
        score: Number(r.score),
        comment: String(r.comment || "").trim().slice(0, 500),
      }))
      .filter((r) => validIds.has(r.id) && Number.isFinite(r.score) && r.score >= 1 && r.score <= 5);
    if (!clean.length)
      return sendJson(res, 400, { ok: false, error: "No valid ratings (scores must be 1-5)" });

    const insertSubmission = db.prepare(
      "INSERT INTO submissions (code, name, email, comment) VALUES (?, ?, ?, ?)",
    );
    const insertRating = db.prepare(
      "INSERT INTO ratings (submission_id, biscuit_id, score, comment) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(submission_id, biscuit_id) DO UPDATE SET score = excluded.score, comment = excluded.comment",
    );

    let submissionId;
    db.exec("BEGIN");
    try {
      const info = insertSubmission.run(
        code || "MAIN",
        name.slice(0, 120),
        String(body.email || "").trim().slice(0, 160) || null,
        String(body.comment || "").trim().slice(0, 1000) || null,
      );
      submissionId = Number(info.lastInsertRowid);
      for (const r of clean) insertRating.run(submissionId, r.id, r.score, r.comment || null);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      console.error("submit failed:", err);
      return sendJson(res, 500, { ok: false, error: "Could not save submission" });
    }

    return sendJson(res, 201, { ok: true, id: submissionId, ratings: clean.length });
  }

  if (pathname === "/api/results" && method === "GET") {
    return sendJson(res, 200, buildResults());
  }

  if (pathname === "/api/submissions" && method === "GET") {
    const rows = db
      .prepare("SELECT id, code, name, comment, created_at FROM submissions ORDER BY id DESC LIMIT 500")
      .all();
    return sendJson(res, 200, { ok: true, submissions: rows });
  }

  return sendJson(res, 404, { ok: false, error: "Unknown endpoint" });
}

function countSubmissions() {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM submissions").get().c);
}

function buildResults() {
  const rows = db
    .prepare(
      `SELECT b.id, b.name, b.emoji, AVG(r.score) AS avg, COUNT(r.score) AS votes
       FROM biscuits b LEFT JOIN ratings r ON r.biscuit_id = b.id
       GROUP BY b.id ORDER BY b.sort`,
    )
    .all();
  const total = countSubmissions();
  const biscuits = rows.map((r) => ({
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    avg: r.avg === null ? 0 : Math.round(Number(r.avg) * 100) / 100,
    votes: Number(r.votes || 0),
  }));
  const leader = biscuits.length
    ? biscuits.reduce((a, b) => (b.votes > 0 && b.avg > a.avg ? b : a), biscuits[0])
    : null;
  const byStation = db
    .prepare(
      `SELECT s.code, COUNT(DISTINCT s.id) AS submissions
       FROM submissions s GROUP BY s.code ORDER BY s.code`,
    )
    .all();
  const recent = db
    .prepare(
      `SELECT s.id, s.name, s.code, s.created_at, ROUND(AVG(r.score), 2) AS avg_score
       FROM submissions s LEFT JOIN ratings r ON r.submission_id = s.id
       GROUP BY s.id ORDER BY s.id DESC LIMIT 20`,
    )
    .all();
  return {
    ok: true,
    total,
    biscuits,
    leader: leader && leader.votes > 0 ? leader : null,
    byStation,
    recent,
  };
}

// ---------------------------------------------------------------- server
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // The frontend may be hosted separately (e.g. GitHub Pages) and call this API cross-origin.
  res.setHeader("access-control-allow-origin", req.headers.origin || "*");
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
    } else if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res, url.pathname);
    } else {
      res.writeHead(405).end("Method not allowed");
    }
  } catch (err) {
    console.error("unhandled error:", err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Arnott's Biscuit Arena running on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});

this is not valid javascript(((
