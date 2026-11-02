#!/usr/bin/env node
// Seekter tracker CLI. Node 20+, no packages.
//
// Layout: applications/<YYYY-MM>/ holds one markdown file per posting (status in the front
// matter; files never move) plus skipped.md, one table row per posting that was passed over.
// applications/README.md and applications/<YYYY-MM>/README.md are generated views.
//
//   node scripts/seekter.mjs check <url|linkedin-id> [--company NAME]   exit 0 new, 1 tracked, 2 hold (same company within the window)
//   printf 'url | company\n4468710729\n' | node scripts/seekter.mjs check-many   (bare numbers = LinkedIn IDs)
//   node scripts/seekter.mjs add --company X --role Y --status applied --url U [...]
//   node scripts/seekter.mjs move <file|url> <status> [--note TEXT]
//   node scripts/seekter.mjs list [--status S] [--since YYYY-MM-DD]
//   node scripts/seekter.mjs index
//   node scripts/seekter.mjs normalize [--dry-run]
//   node scripts/seekter.mjs stats [--since YYYY-MM-DD] [--by FIELD[,FIELD]] [--min N] [--floor N]   (--by: any front-matter field, or title, seniority, month; rates over decided applications, none below --floor, default 5)
//   node scripts/seekter.mjs migrate [--keep-old]         (v1 status folders -> month folders)
//   node scripts/seekter.mjs <command> --json FILE         (every argument from a JSON object; see argsFromJson)
//
// Ported from scripts/seekter.py on 21 Oct 2026. Every record written by the Python version
// reads, keys and rewrites identically; the parity was checked against a 2,058-record tracker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
export const ROOT = path.dirname(HERE);
export const APPS = path.join(ROOT, "applications");
export const STATUSES = ["pending", "applied", "interviewing", "offer", "rejected", "closed", "skipped"];
const FIELDS = ["company", "role", "status", "url", "source", "ats", "apply_type", "location_fit",
  "remote_scope", "fit", "posted", "applied", "updated", "job_key"];

export function isoDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export const TODAY = isoDate(new Date());

function daysAgo(days) {
  const d = new Date();
  return isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - days));
}

// A clean exit with a message, the way sys.exit("...") behaves: message to stderr, code 1.
export class Exit extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}
export function die(message, code = 1) { throw new Exit(message, code); }

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// ---------- URL parsing that matches Python's urllib.parse ----------
// Not the WHATWG URL class: that one percent-encodes the path, punycodes the host and
// rejects some inputs outright, and every job_key already stored was made by urlparse.
// A key that came out differently here would let a tracked posting pass dedup as new.
const SCHEME_CHARS = /^[A-Za-z][A-Za-z0-9+\-.]*$/;
const USES_PARAMS = new Set(["", "ftp", "hdl", "prospero", "http", "imap", "https", "shttp", "rtsp",
  "rtspu", "sip", "sips", "mms", "sftp", "tel"]);

export function urlparse(url) {
  let rest = url.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "", netloc = "", query = "", fragment = "";
  const i = rest.indexOf(":");
  if (i > 0 && SCHEME_CHARS.test(rest.slice(0, i))) {
    scheme = rest.slice(0, i).toLowerCase();
    rest = rest.slice(i + 1);
  }
  if (rest.startsWith("//")) {
    let end = rest.length;
    for (const c of "/?#") {
      const j = rest.indexOf(c, 2);
      if (j >= 0 && j < end) end = j;
    }
    netloc = rest.slice(2, end);
    rest = rest.slice(end);
  }
  const h = rest.indexOf("#");
  if (h >= 0) { fragment = rest.slice(h + 1); rest = rest.slice(0, h); }
  const q = rest.indexOf("?");
  if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q); }
  let pathPart = rest, params = "";
  if (USES_PARAMS.has(scheme) && pathPart.includes(";")) {
    const k = pathPart.includes("/") ? pathPart.indexOf(";", pathPart.lastIndexOf("/")) : pathPart.indexOf(";");
    if (k >= 0) { params = pathPart.slice(k + 1); pathPart = pathPart.slice(0, k); }
  }
  return { scheme, netloc, path: pathPart, params, query, fragment };
}

function unquote(s) {
  if (!s.includes("%")) return s;
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => Buffer.from(run.replace(/%/g, ""), "hex").toString("utf8"));
}

// parse_qs with its defaults: '&' separates, pairs without a value are dropped, '+' is a space.
export function parseQs(qs) {
  const out = new Map();
  for (const pair of qs.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const value = pair.slice(eq + 1);
    if (!value.length) continue;
    const name = unquote(pair.slice(0, eq).replace(/\+/g, " "));
    const v = unquote(value.replace(/\+/g, " "));
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(v);
  }
  return out;
}

const isDigits = (s) => typeof s === "string" && /^\p{Nd}+$/u.test(s);

// ---------- job identity ----------
// Stable identity for a posting, so the same job reached through different URLs matches.
export function jobKey(url) {
  if (!url) return "";
  const u = url.trim();
  const p = urlparse(u.includes("://") ? u : "https://" + u);
  let host = p.netloc.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  const q = parseQs(p.query);
  const first = (k) => (q.get(k) || [])[0];
  let p2 = p.path;
  // LinkedIn writes the id alone (/jobs/view/4001234567/) or after a title slug in share links and
  // alert mails (/jobs/view/senior-designer-at-acme-4001234567/); both are one posting.
  let m = p2.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)(?=\/|$)/);
  if (host.includes("linkedin.com") && m) return `linkedin:${m[1]}`;
  if (host.includes("linkedin.com") && q.has("currentJobId")) return `linkedin:${first("currentJobId")}`;
  for (const k of ["gh_jid", "token"]) {
    if (q.has(k) && isDigits(first(k))) return `greenhouse:${first(k)}`;
  }
  if (q.has("ats_id")) return `ats:${first("ats_id").toLowerCase()}`;
  // Same trap as Indeed below, but on company careers sites: the posting id lives in a
  // generic query param (?jobId=, ?gh_src=..., ?requisitionId=) and the path is identical
  // for every opening, so without this every Celonis/Workday-style posting collapses to
  // "<host>/job-detail" and the first one tracked makes all the others look like duplicates.
  // Measured 24 Sept: careers.celonis.com had two design roles that keyed identically.
  for (const k of ["jobid", "job_id", "requisitionid", "reqid", "posting_id", "postingid", "vacancyid"]) {
    for (const [qk, qv] of q) {
      if (qk.toLowerCase() === k && qv.length && /^\d{4,}$/.test(qv[0])) return `${host}:${qv[0]}`;
    }
  }
  // Hacker News "Who is hiring?" posts are comments, and every one lives at /item?id=<n>.
  // Without this the whole thread is one key. Measured 9 Oct: a skipped volunteer post
  // made the next post applied to from the same thread look like a duplicate.
  if (host === "news.ycombinator.com" && isDigits(first("id"))) return `hn:${first("id")}`;
  // Indeed keeps the posting id in the query string (?jk=, ?vjk= on a search page).
  // Without this, every posting on a domain collapses to "<host>/viewjob" and the
  // first one tracked makes all the others look like duplicates.
  if (host.includes("indeed.")) {
    for (const k of ["jk", "vjk"]) if (first(k)) return `indeed:${first(k).toLowerCase()}`;
  }
  // Breezy slugs are "<position_id>-<title-slug>", and the employer can rename a posting
  // without opening a new one. Keying on the whole path makes a rename look like a brand
  // new job. Measured 25 Sept: Cal.com's ff94f3182ac2 was applied to on 18 Sept as
  // "senior-product-designer", was re-read today as "senior-product-design-engineer",
  // passed dedup as NEW, and only Breezy's own server caught it after the form was filled.
  if (host.includes("breezy.hr")) {
    m = p2.match(/\/p\/([0-9a-f]{8,})/i);
    if (m) return `breezy:${m[1].toLowerCase()}`;
  }
  m = p2.match(new RegExp(UUID, "i"));
  if (m) return `uuid:${m[0].toLowerCase()}`;
  if (host.includes("greenhouse")) {
    m = p2.match(/\/jobs\/(\d+)/);
    if (m) return `greenhouse:${m[1]}`;
  }
  m = p2.match(/\/(\d{7,})(?:[-/]|$)/);
  if (m) return `${host}:${m[1]}`;
  p2 = p2.replace(/\/+$/, "").replace(/\/(application|apply|apply\/)?$/, "");
  // A URL with no path would key on the host alone, which makes every posting on
  // that site one record. Fall back to the fragment, then to the query.
  if (!p2) {
    const tail = p.fragment || p.query;
    if (tail) return `${host}#${tail}`.toLowerCase();
  }
  return `${host}${p2}`.toLowerCase();
}

const ATS_HOSTS = [
  ["ashbyhq.com", "ashby"], ["greenhouse.io", "greenhouse"], ["lever.co", "lever"],
  ["myworkdayjobs.com", "workday"], ["workable.com", "workable"], ["recruitee.com", "recruitee"],
  ["personio.", "personio"], ["teamtailor.com", "teamtailor"], ["smartrecruiters.com", "smartrecruiters"],
  ["bamboohr.com", "bamboohr"], ["pinpointhq.com", "pinpoint"], ["breezy.hr", "breezy"],
  ["rippling.com", "rippling"], ["icims.com", "icims"], ["taleo.net", "taleo"], ["join.com", "join"],
  ["homerun.co", "homerun"], ["hire.trakstar.com", "trakstar"], ["jobylon.com", "jobylon"],
  ["hr-on.com", "hr-on"], ["dayforcehcm.com", "dayforce"], ["successfactors", "successfactors"],
  ["docs.google.com/forms", "google-forms"], ["forms.gle", "google-forms"],
  ["linkedin.com", "linkedin"], ["djinni.co", "djinni"],
];
// Values that are an application system, not a place the posting was found.
const ATS_NAMES = new Set(ATS_HOSTS.map(([, v]) => v).filter((v) => v !== "linkedin" && v !== "djinni"));

export function atsFromUrl(url) {
  const u = (url || "").toLowerCase();
  for (const [host, name] of ATS_HOSTS) if (u.includes(host)) return name;
  return "";
}

// 'Company site' -> 'company-site', 'Other board' -> 'other-board'.
export function norm(v) {
  return (v || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// NFKD folds a letter to ASCII only when it decomposes into a base letter plus a
// combining mark. A letter that is its own base character has no decomposition, so
// dropping non-ASCII afterwards deletes it outright: dotless ı, Polish ł, Nordic ø/æ,
// Croatian đ, German ß and Icelandic þ/ð all vanish, so an employer name reached a
// filename with a letter missing ("desgn" for "desıgn"). `slug` is also what the
// same-company check compares, so two different employers could fold onto one
// string: "Lıght" and "Lght" both became "lght".
const FOLD = { ı: "i", İ: "I", ł: "l", Ł: "L", ø: "o", Ø: "O", đ: "d", Đ: "D", ð: "d", Ð: "D", ß: "ss",
  æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", þ: "th", Þ: "TH" };

export function slug(s, n = 40) {
  let t = [...(s || "")].map((c) => FOLD[c] ?? c).join("");
  t = t.normalize("NFKD").replace(/[^\x00-\x7F]/g, "");
  t = t.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return t.slice(0, n).replace(/-+$/, "") || "x";
}

// ---------- storage ----------
// applications/<YYYY-MM>/<date>--<company>--<role>.md   one file per posting that isn't a skip;
//                                                      status lives in the front matter, files never move
// applications/<YYYY-MM>/skipped.md                    one table row per skipped posting
const MONTH_RE = /^\d{4}-\d{2}$/;
const SKIP_COLS = ["Date", "Company", "Role", "Reason", "Source", "Link", "Key"];
const LINE_BREAK = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]");

const monthOf = (date) => (date || TODAY).slice(0, 7);
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const rel = (p, base = ROOT) => path.relative(base, p).split(path.sep).join("/");
// Python's read_text() turns \r\n into \n; on Windows its write_text() wrote \r\n.
const readText = (p) => fs.readFileSync(p, "utf8").replace(/\r\n?/g, "\n");
const pyStr = (v) => (v === undefined || v === null ? "None" : String(v));
const present = (v) => v !== undefined && v !== null && v !== "";

function mdFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith(".") && isFile(path.join(dir, f))).sort();
}

export function monthDirs() {
  if (!isDir(APPS)) return [];
  return fs.readdirSync(APPS).filter((d) => MONTH_RE.test(d) && isDir(path.join(APPS, d))).sort()
    .map((d) => path.join(APPS, d));
}

export function read(p) {
  const text = readText(p);
  const meta = {};
  let body = text;
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) {
      for (const line of text.slice(4, end).split(LINE_BREAK)) {
        const i = line.indexOf(":");
        if (i >= 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      body = text.slice(end + 4).replace(/^\n+/, "");
    }
  }
  meta._path = p;
  meta._body = body;
  meta._kind = "file";
  return meta;
}

export function write(p, meta, body) {
  const lines = ["---"];
  for (const k of FIELDS) if (present(meta[k])) lines.push(`${k}: ${String(meta[k]).replace(/\n/g, " ")}`);
  for (const [k, v] of Object.entries(meta)) {
    if (!FIELDS.includes(k) && !k.startsWith("_") && present(v)) lines.push(`${k}: ${String(v).replace(/\n/g, " ")}`);
  }
  lines.push("---");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join("\n") + "\n\n" + body.trimEnd() + "\n", "utf8");
}

// One table cell. Idempotent: an already-escaped pipe is not escaped again,
// otherwise a value round-tripping through the table grows a backslash each pass.
export function cell(v) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.replace(/\\\|/g, "|").replace(/\|/g, "\\|");
}

export function splitRow(line) {
  const inner = line.trim().replace(/^\|+|\|+$/g, "");
  return inner.split(/(?<!\\)\|/).map((p) => p.trim().replace(/\\\|/g, "|"));
}

export function readSkips(p) {
  const out = [];
  if (!fs.existsSync(p)) return out;
  readText(p).split(LINE_BREAK).forEach((line, n) => {
    if (!line.startsWith("| ") || line.startsWith("| Date |")) return;
    const cells = splitRow(line);
    if (cells.length < SKIP_COLS.length) return;
    const d = Object.fromEntries(SKIP_COLS.map((c, i) => [c, cells[i]]));
    const url = d.Link.replace(/^<+|>+$/g, "");
    // `ats` has no column of its own: it is a pure function of the URL, so it is
    // derived on read. Without it every row would look unnormalised on every pass.
    out.push({ updated: d.Date, company: d.Company, role: d.Role, notes: d.Reason, source: d.Source, url,
      job_key: d.Key || jobKey(url), status: "skipped", ats: atsFromUrl(url),
      _path: p, _kind: "row", _line: n, _body: "" });
  });
  return out;
}

export function writeSkips(p, recs) {
  const sorted = [...recs].sort((a, b) => {
    const x = [a.updated || "", (a.company || "").toLowerCase()];
    const y = [b.updated || "", (b.company || "").toLowerCase()];
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0;
  });
  const lines = [`# Skipped · ${path.basename(path.dirname(p))}`, "",
    "Postings looked at and not applied to, with the reason. Written by `scripts/seekter.mjs`; " +
    "dedup reads the Key column, so a posting here is never evaluated twice.", "",
    "| " + SKIP_COLS.join(" | ") + " |", "|" + "---|".repeat(SKIP_COLS.length)];
  for (const r of sorted) {
    const link = r.url ? `<${r.url}>` : "";
    lines.push("| " + [r.updated || "", r.company || "", r.role || "", r.notes || "", r.source || "", link,
      r.job_key || ""].map(cell).join(" | ") + " |");
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
}

export function allApps() {
  const out = [];
  for (const d of monthDirs()) {
    for (const f of mdFiles(d)) {
      if (f === "skipped.md" || f === "README.md") continue;
      out.push(read(path.join(d, f)));
    }
    out.push(...readSkips(path.join(d, "skipped.md")));
  }
  return out;
}

export function label(r) {
  return rel(r._path) + (r._kind === "row" ? ` (row: ${pyStr(r.company)})` : "");
}

function find(target) {
  let p = target.startsWith("~") ? path.join(os.homedir(), target.slice(1)) : target;
  if (!path.isAbsolute(p)) p = isFile(path.join(process.cwd(), p)) ? path.join(process.cwd(), p) : path.join(ROOT, p);
  if (isFile(p) && path.basename(p) !== "skipped.md") return read(fs.realpathSync(p));
  const key = jobKey(target);
  for (const a of allApps()) if (a.job_key === key || jobKey(a.url || "") === key) return a;
  return null;
}

function newFilePath(date, company, role) {
  const name = `${date}--${slug(company, 30)}--${slug(role, 40)}.md`;
  let p = path.join(APPS, monthOf(date), name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(path.dirname(p), name.replaceAll(".md", `-${i}.md`));
  return p;
}

export function bodyFor(role, company, why = "", notes = "", answers = "", log = "") {
  return `# ${role} · ${company}\n\n## Why it fits\n\n${why}\n\n## Notes\n\n${notes}\n\n` +
    `## Answers submitted\n\n${answers}\n\n## Log\n\n${log}\n`;
}

// Store a new record in the right place for its status. Returns the path written.
export function save(meta, body = "", log = "") {
  fixMeta(meta);
  const date = meta.applied || meta.updated || TODAY;
  if (meta.status === "skipped") {
    const p = path.join(APPS, monthOf(date), "skipped.md");
    const recs = readSkips(p);
    recs.push({ ...meta, updated: meta.updated || date });
    writeSkips(p, recs);
    return p;
  }
  const p = newFilePath(date, meta.company, meta.role);
  write(p, meta, body || bodyFor(meta.role, meta.company, "", "", "", log));
  return p;
}

function remove(r) {
  if (r._kind === "row") writeSkips(r._path, readSkips(r._path).filter((x) => x._line !== r._line));
  else fs.unlinkSync(r._path);
}

// Add a log line, once. Running the same `move` twice (a re-run script, a retried
// batch) used to write the identical line twice; measured 6 Oct on 27 records.
export function appendLog(body, line) {
  if (!body.includes("## Log")) body += "\n## Log\n";
  const lines = body.trimEnd().split(LINE_BREAK).filter((x) => x.trim());
  if (lines.length && lines[lines.length - 1].trim() === line.trim()) return body.trimEnd() + "\n";
  return body.trimEnd() + "\n" + line + "\n";
}

function sectionMatch(body, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = body.match(new RegExp(`(## ${esc}\\n)([\\s\\S]*?)(?=\\n## |$)`));
  if (!m) return null;
  const start = m.index + m[1].length;
  return { start, end: start + m[2].length, text: m[2] };
}

// Collapse adjacent identical lines in the Log section.
export function dedupeLog(body) {
  const m = sectionMatch(body, "Log");
  if (!m) return body;
  const out = [];
  for (const x of m.text.match(/[^\n]*\n|[^\n]+/g) || []) {
    if (x.trim() && out.length && x.trim() === out[out.length - 1].trim()) continue;
    out.push(x);
  }
  return body.slice(0, m.start) + out.join("") + body.slice(m.end);
}

// Append submitted answers to the record's Answers section.
//
// A form often gets its free text after the record exists: the record is opened as a
// hand-off, the user supplies the missing facts, and the form is submitted later.
// Without this the answers could only be added by editing the file by hand, which the
// tracker forbids (measured 6 Oct, Secfix).
export function addAnswers(body, text) {
  text = (text || "").trim();
  if (!text) return body;
  const m = sectionMatch(body, "Answers submitted");
  if (!m) {
    const cut = body.indexOf("## Log");
    const block = `## Answers submitted\n\n${text}\n\n`;
    return cut >= 0 ? body.slice(0, cut) + block + body.slice(cut) : body.trimEnd() + "\n\n" + block;
  }
  const old = m.text.trim();
  if (old.includes(text)) return body;
  const fresh = old ? `\n${old}\n\n${text}\n` : `\n${text}\n`;
  return body.slice(0, m.start) + fresh + body.slice(m.end);
}

export function section(body, name) {
  const m = sectionMatch(body, name);
  return m ? m.text.trim() : "";
}

const SENT = ["applied", "interviewing", "offer", "rejected", "closed"];

// Why this record must not be collapsed into a skip row, or "" if it may be.
//
// A skip row holds a date, a company, a role and one line of reason. That is the whole
// record for a posting that was only ever looked at. For a posting that was applied to,
// it would throw away the submitted answers, the log and the application date, so those
// stay files, with `status: skipped`.
function keepAsFile(r) {
  if (r._kind !== "file") return "";
  if (section(r._body || "", "Answers submitted")) return "it records submitted answers";
  if (r.applied) return `it was applied to on ${r.applied}`;
  if (SENT.includes(r.status)) return `its status is '${r.status}'`;
  return "";
}

// ---------- normalisation ----------
// Normalise one record: lowercase-hyphen enums, ATS derived from the URL,
// and an ATS name misfiled as `source` moved to `ats`.
export function fixMeta(r) {
  const keys = ["source", "ats", "apply_type", "job_key"];
  const before = Object.fromEntries(keys.map((k) => [k, r[k] ?? ""]));
  let src = norm(r.source), ats = norm(r.ats);
  if (src === "other-board") src = "board";
  if (ATS_NAMES.has(src)) {
    ats = ats || src;
    src = "board"; // the tracker only knew the form system, not where the posting was found
  }
  r.source = src;
  r.ats = ats || atsFromUrl(r.url || "");
  r.apply_type = norm(r.apply_type);
  if (r.url && !r.job_key) r.job_key = jobKey(r.url);
  const changed = {};
  for (const k of keys) if (before[k] !== (r[k] ?? "")) changed[k] = [before[k], r[k] ?? ""];
  return changed;
}

// ---------- one application per company ----------
// Greenhouse lets an employer auto-reject a candidate's further applications to a
// department within a window, or after a rejection, and the candidate is told only if
// the employer switches that on ("blocked by auto reject rule"). So a second role at the
// same company inside the window can be a silent loss that also looks like spam.
// Measured 2 Oct: two roles at one company and a second role at another went out the same
// afternoon. The window is the candidate's (`same_company_days` in profile/settings.json).
const HOLDING = ["pending", "applied", "rejected"];   // within the window
const ALWAYS_HOLDING = ["interviewing", "offer"];      // a live process holds regardless of date

// ---------- settings ----------
// One file holds every switch and number: profile/settings.json, over the defaults in
// templates/settings.json. A key the user never set falls back to the template, so a
// half-finished /seekter-init still runs. profile/search.json is the old name; it is
// moved, not rewritten, the first time anything reads the settings.
const SETTINGS = path.join(ROOT, "profile", "settings.json");
const LEGACY_SETTINGS = path.join(ROOT, "profile", "search.json");
const SETTINGS_TEMPLATE = path.join(ROOT, "templates", "settings.json");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function merge(defaults, mine) {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(mine)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  return out;
}

function defaults() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_TEMPLATE, "utf8")); } catch { return {}; }
}

export class SettingsError extends Error {}

// The user's settings over the template's defaults. With create=true a missing
// profile/settings.json is copied from the template, which is what /seekter-run does
// at start so the user has a file to edit.
export function settings(create = false) {
  if (!fs.existsSync(SETTINGS) && fs.existsSync(LEGACY_SETTINGS)) {
    fs.renameSync(LEGACY_SETTINGS, SETTINGS);
    console.error("moved profile/search.json to profile/settings.json (values unchanged)");
  } else if (fs.existsSync(SETTINGS) && fs.existsSync(LEGACY_SETTINGS)) {
    console.error("warning: both profile/settings.json and profile/search.json exist; only settings.json is read." +
      " Move any value you still need from search.json, then delete it.");
  }
  if (!fs.existsSync(SETTINGS)) {
    if (create && fs.existsSync(SETTINGS_TEMPLATE)) {
      fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
      fs.copyFileSync(SETTINGS_TEMPLATE, SETTINGS);
      console.error("created profile/settings.json from the template; every value is a default");
    }
    return defaults();
  }
  let mine;
  try { mine = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch (e) { throw new SettingsError(e.message); }
  if (!isObj(mine)) throw new SettingsError("the top level must be an object { ... }");
  for (const k of ["linkedin", "freehire"]) {
    if (k in mine && !isObj(mine[k])) throw new SettingsError(`"${k}" must be an object { ... }`);
  }
  return merge(defaults(), mine);
}

function toInt(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  throw new Error(`invalid literal for int(): ${JSON.stringify(v)}`);
}

export function sameCompanyDays() {
  try {
    const v = settings().same_company_days;
    return toInt(v === undefined ? 30 : v);
  } catch (e) {
    // Never silently: a broken file would otherwise turn a 90-day window into 30.
    console.error(`warning: profile/settings.json could not be read (${e.message}); using 30 days`);
    return 30;
  }
}

// `query` names the employer in `company`: the same name, or whole words of it.
//
// A substring is not enough. Measured 5 and 6 Oct: "telli" matched Intellias and
// Intermedia Intelligent, and "Flex" matched WorkFlex and Engiflex, so both were held
// under the 30-day rule for companies they had never applied to. A held posting is
// skipped, so a false match costs an application, not a line of output.
export function sameCompany(query, company) {
  const q = slug(query, 80), c = slug(company, 80);
  if (!(query || "").trim() || q === "x") return false;
  return q === c || new RegExp(`(?:^|-)${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-|$)`).test(c);
}

// Companies large enough that one team's hiring says nothing about another's (Amazon, Google,
// Microsoft…): the candidate lists them in `same_company_exempt`, and a posting there is never
// held by the window. `check` still prints the earlier roles, so a repost of the same role is
// caught by reading them (seekter-run section 2, rule 1.6).
export function companyExempt(company) {
  let list = [];
  try { list = settings().same_company_exempt || []; } catch { list = []; }
  return Array.isArray(list) && list.some((n) => typeof n === "string" && sameCompany(n, company || ""));
}

function holding(records, days) {
  const since = daysAgo(days);
  return records.filter((r) => ALWAYS_HOLDING.includes(r.status) ||
    (HOLDING.includes(r.status) && (r.applied || r.updated || "") >= since));
}

// A bare number is a LinkedIn job id, in `check` as in `check-many`.
function bareIdToUrl(url) {
  url = url.trim();
  return /^\p{Nd}+$/u.test(url) ? `https://www.linkedin.com/jobs/view/${url}/` : url;
}

// ---------- commands ----------
// The same posting under a different URL on the same site. jobKey stays as it is, because
// 2,000 stored keys depend on it; this is a second look at keys that did not match exactly.
// Measured 22 Oct 2026: a careers site's posting was tracked as ".../job/P-100931/<title-slug>"
// and came back from LinkedIn as ".../job/P-100931/<title-slug cut short>", passed `check` as
// NEW and had its form opened again. Two signals, both on the same host only: one path is the
// other cut short (a slug truncated by whoever passed the link on), or both carry the same
// posting id, a run of five or more digits with an optional short letter prefix ("P-100931",
// "_261413-1").
const postingIds = (key) => new Set([...key.split("/").slice(1).join("/").matchAll(/(?:^|[/_-])([a-z]{0,3}-?\d{5,})(?=$|[/_-])/gi)]
  .map((m) => m[1].toLowerCase().replace(/^[a-z]{0,3}-?/, (x) => x.replace("-", ""))));
export function samePosting(key, other) {
  if (!key || !other || key === other || !key.includes("/") || !other.includes("/")) return "";
  if (/^[a-z]+:/.test(key) || /^[a-z]+:/.test(other)) return ""; // linkedin:, uuid:, greenhouse:… are exact by design
  const host = (k) => k.slice(0, k.indexOf("/"));
  if (host(key) !== host(other)) return "";
  const [short, long] = key.length <= other.length ? [key, other] : [other, key];
  if (long.startsWith(short) && short.length >= host(short).length + 15) return "a shortened copy of the same URL";
  const mine = postingIds(key);
  for (const id of postingIds(other)) if (mine.has(id)) return `the same posting id (${id})`;
  return "";
}

function cmdCheck(a) {
  const key = jobKey(bareIdToUrl(a.url));
  const same = [], company = [];
  for (const r of allApps()) {
    if (key && (r.job_key === key || jobKey(r.url || "") === key)) same.push(r);
    else if (a.company && sameCompany(a.company, r.company || "")) company.push(r);
  }
  let why = "";
  if (!same.length) {
    for (const r of allApps()) {
      const w = samePosting(key, r.job_key || jobKey(r.url || ""));
      if (w) { same.push(r); why = why || w; }
    }
  }
  if (same.length) {
    console.log("DUPLICATE: this posting is already tracked" + (why ? ` (same posting under another URL: ${why})` : ""));
    for (const r of same) console.log(`  ${pyStr(r.status)} | ${pyStr(r.company)} | ${pyStr(r.role)} | ${label(r)}`);
    return 1;
  }
  console.log(`NEW  key=${key}`);
  for (const r of company) {
    console.log(`  same company, other role: ${pyStr(r.status)} | ${pyStr(r.role)} | ${pyStr(r.applied || r.updated)}`);
  }
  const days = sameCompanyDays();
  if (company.length && companyExempt(a.company)) {
    console.log(`not held: ${pyStr(a.company)} is in same_company_exempt; read the roles above for a repost`);
    return 0;
  }
  if (holding(company, days).length) {
    console.log(`HOLD: one application per company per ${days} days. Apply only if the user says so;` +
      " otherwise skip with this reason, or pick the better-fitting role while neither has gone out.");
    return 2;
  }
  return 0;
}

// stdin: one posting per line, 'url' or 'url | company'. Prints NEW / DUP / SAMECO / HOLD per line.
function cmdCheckMany() {
  const apps = allApps();
  const keys = new Map(apps.map((r) => [r.job_key || jobKey(r.url || ""), r]));
  const days = sameCompanyDays();
  let input = "";
  try { input = fs.readFileSync(0, "utf8"); } catch { input = ""; }
  for (let line of input.split(LINE_BREAK)) {
    line = line.trim();
    if (!line) continue;
    const bar = line.indexOf("|");
    let url = (bar >= 0 ? line.slice(0, bar) : line).trim();
    const co = bar >= 0 ? line.slice(bar + 1).trim() : "";
    url = bareIdToUrl(url);
    const key = jobKey(url);
    let r = keys.get(key), why = "";
    if (!r) for (const [k, x] of keys) { why = samePosting(key, k); if (why) { r = x; break; } }
    if (r) {
      console.log(`DUP    ${line} -> ${pyStr(r.status)} ${label(r)}` + (why ? ` (${why})` : ""));
      continue;
    }
    const same = apps.filter((x) => co && sameCompany(co, x.company || ""));
    const tag = holding(same, days).length && !companyExempt(co) ? "HOLD   " : same.length ? "SAMECO " : "NEW    ";
    const tail = same.length ? ` -> ${same.length} earlier: ` +
      same.slice(0, 3).map((x) => `${pyStr(x.status)}:${pyStr(x.role)}`).join(", ") : "";
    console.log(tag + line + tail);
  }
  return 0;
}

function cmdAdd(a) {
  if (!STATUSES.includes(a.status)) die(`status must be one of ${pyList(STATUSES)}`);
  // The fit score is a defined 1-5 scale (seekter-run §3). Free text and a 10-point scale both
  // slipped into the tracker before it had a definition, and neither can be grouped.
  if (present(a.fit) && !/^[1-5]$/.test(String(a.fit).trim())) die(`fit must be a whole number from 1 to 5, got "${a.fit}"`);
  const key = jobKey(a.url || "");
  if (key && !a.force) {
    for (const r of allApps()) {
      if (r.job_key === key) die(`DUPLICATE: ${label(r)} (use --force to add anyway)`);
      const why = samePosting(key, r.job_key || "");
      if (why) die(`DUPLICATE: ${label(r)}, ${why} (use --force to add anyway)`);
    }
  }
  const today = a.date || TODAY;
  const meta = { company: a.company, role: a.role, status: a.status, url: a.url, source: a.source, ats: a.ats,
    apply_type: a.apply_type, location_fit: a.location_fit, remote_scope: a.remote_scope, fit: a.fit,
    posted: a.posted, applied: a.applied || (a.status === "applied" ? today : ""), updated: today, job_key: key };
  // Which resume type went with the application, so outcomes can be read per type later.
  if (a.resume) meta.resume = a.resume;
  let p;
  if (a.status === "skipped") {
    meta.notes = a.notes || a.why;
    p = save(meta);
  } else {
    const log = `- ${today}: ${a.status}` + (a.log ? `. ${a.log}` : "");
    p = save(meta, bodyFor(a.role, a.company, a.why, a.notes, a.answers, log));
  }
  console.log(rel(p));
  if (!a.no_index) cmdIndex(null, true);
  return 0;
}

const stripPrivate = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_")));

export function cmdMove(a) {
  if (!STATUSES.includes(a.status)) die(`status must be one of ${pyList(STATUSES)}`);
  const r = find(a.target);
  if (!r) die("not found");
  const note = `- ${TODAY}: ${a.status}` + (a.note ? `. ${a.note}` : "");
  let p;
  if (r._kind === "row" && a.status === "skipped") {
    if (a.answers) console.error("a skip row has no answers section; answers were not stored");
    if (!a.note) { console.log("already skipped: " + label(r)); return 0; }
    // Re-annotating a skip is the only way to correct a reason that turned out to be
    // wrong, because the tracker is CLI-only and hand-editing the table is forbidden.
    // Keep the original reason and append the correction after it, dated, so the
    // record shows both what was decided and why it changed.
    remove(r);
    const meta = stripPrivate(r);
    Object.assign(meta, { status: "skipped", updated: TODAY,
      notes: [r.notes || "", `[${TODAY}] ${a.note}`].filter(Boolean).join(" ") });
    p = save(meta);
    console.log(rel(p));
    cmdIndex(null, true);
    return 0;
  }
  if (r._kind === "row") {
    // a skip turned into something else: it gets its own file
    remove(r);
    const meta = stripPrivate(r);
    const reason = meta.notes ?? "";
    delete meta.notes;
    Object.assign(meta, { status: a.status, updated: TODAY });
    if (a.status === "applied") meta.applied = TODAY;
    p = save(meta, bodyFor(meta.role, meta.company, "", `Skipped earlier: ${reason}`, a.answers,
      `- ${pyStr(r.updated)}: skipped\n${note}`));
  } else if (a.status === "skipped") {
    const meta = stripPrivate(r);
    const keep = keepAsFile(r);
    if (keep) {
      // Collapsing this to a table row would drop the answers, the reasoning and the
      // dates, and `--answers` is what makes "no sentence twice" checkable. A skip that
      // was once a real application stays a file.
      const body = addAnswers(r._body, a.answers);
      Object.assign(meta, { status: "skipped", updated: TODAY });
      write(r._path, meta, appendLog(body, note));
      p = r._path;
      console.error(`kept as a file rather than a skip row: ${keep}`);
    } else {
      remove(r);
      Object.assign(meta, { status: "skipped", updated: TODAY,
        notes: [a.note, section(r._body, "Notes")].filter(Boolean).join(" ") });
      p = save(meta);
    }
  } else {
    p = r._path;
    const meta = stripPrivate(r);
    Object.assign(meta, { status: a.status, updated: TODAY });
    if (a.status === "applied" && !meta.applied) meta.applied = TODAY;
    const body = addAnswers(r._body, a.answers);
    write(p, meta, appendLog(body, note));
  }
  console.log(rel(p));
  cmdIndex(null, true);
  return 0;
}

const pyList = (xs) => "[" + xs.map((x) => `'${x}'`).join(", ") + "]";

// Values that can't have a default: without them no form can be filled honestly.
// Everything else still `{{...}}` in the profile is simply unknown, and the run asks.
const REQUIRED_PROFILE = { EMAIL: "application email", CV_DEFAULT: "default CV", COUNTRY: "country you live and work in" };

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Settings left out of the user's file or still equal to the template's value.
function defaulted(defs, mine, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(defs)) {
    if (k.startsWith("_")) continue;
    if (isObj(v) && isObj(mine[k])) out.push(...defaulted(v, mine[k], prefix + k + "."));
    else if (!(k in mine) || deepEqual(mine[k], v)) out.push(prefix + k);
  }
  return out;
}

function cmdSettings(a) {
  let cfg;
  try { cfg = settings(true); } catch (e) {
    if (e instanceof SettingsError) die(`problem: profile/settings.json is not valid: ${e.message}`);
    throw e;
  }
  if (!a.check) {
    const clean = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith("_"))
      .map(([k, v]) => [k, isObj(v) ? clean(v) : v]));
    console.log(JSON.stringify(clean(cfg), null, 1));
    return 0;
  }
  const problems = [];
  if (!["email", "read"].includes((cfg.linkedin || {}).mode)) problems.push("linkedin.mode must be email or read");
  const days = cfg.same_company_days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0) problems.push("same_company_days must be a whole number of days");
  const exempt = cfg.same_company_exempt;
  if (exempt !== undefined && !(Array.isArray(exempt) && exempt.every((n) => typeof n === "string"))) problems.push("same_company_exempt must be a list of company names");
  const minFit = cfg.easy_apply_min_fit;
  if (minFit !== undefined && !(Number.isInteger(minFit) && minFit >= 1 && minFit <= 5)) problems.push("easy_apply_min_fit must be a whole number from 1 to 5");
  const prof = path.join(ROOT, "profile", "profile.md");
  const text = fs.existsSync(prof) ? fs.readFileSync(prof, "utf8") : "";
  if (!text) problems.push("profile/profile.md is missing (run /seekter-init)");
  for (const [key, what] of Object.entries(REQUIRED_PROFILE)) {
    if (text && text.includes("{{" + key + "}}")) {
      problems.push(`profile/profile.md has no ${what} yet ({{${key}}}; run /seekter-init or fill it in)`);
    }
  }
  // A resume is either a file the candidate brought (profile/documents/) or one Seekter prints
  // from the master resume (profile/resume/json/resume.json, printed into profile/resume/).
  const resumeFiles = ["documents", "resume"].map((d) => path.join(ROOT, "profile", d)).filter(isDir)
    .flatMap((d) => fs.readdirSync(d).filter((f) => !f.startsWith(".")));
  const hasMaster = fs.existsSync(path.join(ROOT, "profile", "resume", "json", "resume.json"));
  if (text && !hasMaster && !resumeFiles.some((f) => [".pdf", ".docx", ".doc"].includes(path.extname(f).toLowerCase()))) {
    problems.push("no resume yet: put a .pdf, .doc or .docx in profile/documents/, or a master resume at profile/resume/json/resume.json");
  }
  let mine = {};
  try { mine = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch { mine = {}; }
  const left = defaulted(defaults(), isObj(mine) ? mine : {});
  if (left.length) console.log("using defaults for: " + left.join(", "));
  if (problems.length) {
    console.log(problems.map((p) => "problem: " + p).join("\n"));
    return 1;
  }
  console.log("settings ok");
  return 0;
}

export function rows(since = null, status = null) {
  const out = allApps().filter((r) => {
    const d = r.applied || r.updated || "";
    if (since && d < since) return false;
    if (status && r.status !== status) return false;
    return true;
  });
  const when = (r) => r.applied || r.updated || "";
  return out.sort((x, y) => (when(x) < when(y) ? 1 : when(x) > when(y) ? -1 : 0));
}

function cmdList(a) {
  for (const r of rows(a.since, a.status)) {
    console.log(`${pyStr(r.applied || r.updated)} | ${pyStr(r.status).padEnd(12)} | ${pyStr(r.company)} | ${pyStr(r.role)} | ${r.url ?? ""}`);
  }
  return 0;
}

function counts(rs) {
  const c = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rs) { const s = r.status || "pending"; c[s] = (c[s] || 0) + 1; }
  return [c, SENT.reduce((n, s) => n + c[s], 0)];
}

function cmdStats(a) {
  if (a.by) return cmdBreakdown(a);
  const [c, sent] = counts(rows(a.since));
  const total = Object.values(c).reduce((x, y) => x + y, 0);
  let rate = "null";
  if (sent) {
    const v = Number(((c.interviewing + c.offer + c.rejected) / sent).toFixed(3));
    rate = Number.isInteger(v) ? v.toFixed(1) : String(v);
  }
  const lines = [`"total": ${total}`, `"sent": ${sent}`, ...Object.entries(c).map(([k, v]) => `${JSON.stringify(k)}: ${v}`),
    `"response_rate": ${rate}`];
  console.log("{\n " + lines.join(",\n ") + "\n}");
  return 0;
}

// What happened to a sent application. A reply is any answer from the employer; an interview
// is a record that reached `interviewing` or `offer` at some point, which the log keeps even
// after a later rejection or close. Six interviews in 561 sends is why both are counted:
// replies are the only outcome with enough volume to compare groups by.
const reachedInterview = (r) => /^(interviewing|offer)$/.test(r.status || "") ||
  /^- \d{4}-\d{2}-\d{2}: (interviewing|offer)\b/m.test(r._body || "");
const SENIORITY = ["intern", "junior", "mid", "senior", "staff", "principal", "lead", "head", "director"];
// Grouping keys derived from a record. `title` is the role with seniority words, brackets and
// anything after a dash or comma removed, so "Senior Product Designer (Growth)" and
// "Product Designer - AI" both land under "product designer".
export function groupKey(r, field) {
  const role = String(r.role || "").toLowerCase();
  if (field === "seniority") return SENIORITY.find((w) => new RegExp(`\\b${w}\\b`).test(role)) || "none";
  if (field === "title") {
    const t = role.replace(/\(.*?\)|\[.*?\]/g, " ").split(/\s[-–—|,:]\s|,/)[0]
      .replace(new RegExp(`\\b(${SENIORITY.join("|")}|sr\\.?|jr\\.?|ii|iii|iv)\\b`, "g"), " ").replace(/[^a-z0-9/&+ ]/g, " ")
      .replace(/\s+/g, " ").replace(/^[/&+ ]+|[/&+ ]+$/g, "").trim();
    return t || "(none)";
  }
  if (field === "month") return String(r.applied || r.updated || "").slice(0, 7) || "(none)";
  const v = r[field.replace(/-/g, "_")];
  return v === undefined || v === null || v === "" ? "(none)" : String(v);
}

// Rates are taken over decided applications only: a reply, or closed. One still waiting is in
// flight, counted in its own column and kept out of every rate, because a week-old application
// with no answer yet is not a "no", and the newest group (often the best-scored one) would be
// pulled down by it. A rate also needs --floor decided applications (default 5) behind it;
// below that the row shows counts and no percentage, since 2 of 3 is an anecdote, not a rate.
// The way career-ops' calibrate.mjs reads its own score; measured 22 Oct 2026, when 365 of 561
// sent applications were still `applied` and every fit group's rate was diluted by them.
function cmdBreakdown(a) {
  const fields = String(a.by).split(",").map((f) => f.trim()).filter(Boolean);
  const sent = rows(a.since).filter((r) => SENT.includes(r.status));
  const replied = (r) => ["interviewing", "offer", "rejected"].includes(r.status) || reachedInterview(r);
  const inFlight = (r) => r.status === "applied" && !reachedInterview(r);
  const tally = (list) => {
    const g = { sent: list.length, flight: 0, decided: 0, replied: 0, interview: 0 };
    for (const r of list) {
      if (inFlight(r)) { g.flight++; continue; }
      g.decided++;
      if (replied(r)) g.replied++;
      if (reachedInterview(r)) g.interview++;
    }
    return g;
  };
  const byKey = new Map();
  for (const r of sent) {
    const k = fields.map((f) => groupKey(r, f)).join(" · ");
    byKey.set(k, [...(byKey.get(k) || []), r]);
  }
  const groups = [...byKey.entries()].map(([k, list]) => [k, tally(list)]);
  const min = Number(a.min ?? 1), floor = Number(a.floor ?? 5);
  const pct = (n, d) => (d >= floor ? `${Math.round((n / d) * 1000) / 10}%` : `n<${floor}`);
  const all = groups.sort((x, y) => y[1].sent - x[1].sent || (x[0] < y[0] ? -1 : 1));
  const shown = all.filter(([, g]) => g.sent >= min);
  const out = [`| ${fields.join(" · ")} | sent | in flight | replies | reply rate | interviews | interview rate |`, "|---|---|---|---|---|---|---|"];
  const row = (k, g) => `| ${k} | ${g.sent} | ${g.flight} | ${g.replied} | ${pct(g.replied, g.decided)} | ${g.interview} | ${pct(g.interview, g.decided)} |`;
  for (const [k, g] of shown) out.push(row(cell(k), g));
  out.push(row("**all**", tally(sent)));
  out.push("", `Rates are over decided applications (a reply, or closed); in flight is still waiting and counts in no rate.`);
  if (shown.length < all.length) out.push(`${all.length - shown.length} smaller groups (under ${min} sent) not shown.`);
  // One line that answers the question the breakdown is usually run for: do the groups differ?
  const rated = shown.filter(([, g]) => g.decided >= floor).sort((x, y) => y[1].replied / y[1].decided - x[1].replied / x[1].decided);
  if (rated.length >= 2) {
    const [hk, h] = rated[0], [lk, l] = rated[rated.length - 1];
    out.push(`Highest reply rate: ${hk} ${pct(h.replied, h.decided)} of ${h.decided} decided; lowest: ${lk} ${pct(l.replied, l.decided)} of ${l.decided}.`);
  } else out.push(`Fewer than two groups have ${floor} decided applications, so no comparison.`);
  console.log(out.join("\n"));
  return 0;
}

function cmdNormalize(a) {
  let files = 0, rowsChanged = 0;
  for (const d of monthDirs()) {
    const recs = readSkips(path.join(d, "skipped.md"));
    // every record, not `some(...)`: that short-circuits on the first change and
    // leaves the rest of the table unnormalised.
    const hits = recs.filter((r) => Object.keys(fixMeta(r)).length).length;
    if (hits) {
      rowsChanged += hits;
      if (!a.dry_run) writeSkips(path.join(d, "skipped.md"), recs);
    }
    for (const f of mdFiles(d)) {
      if (f === "skipped.md" || f === "README.md") continue;
      const r = read(path.join(d, f));
      const p = r._path, body = r._body;
      delete r._path; delete r._body; delete r._kind;
      const clean = dedupeLog(body);
      const fixed = Object.keys(fixMeta(r)).length > 0; // always run: it rewrites the metadata in place
      if (fixed || clean !== body) {
        files++;
        if (!a.dry_run) write(p, r, clean);
      }
    }
  }
  console.log(`${files} files and ${rowsChanged} skip rows ${a.dry_run ? "would change" : "normalised"}`);
  return 0;
}

const cut = (s, n) => [...s].slice(0, n).join("");

function linkCell(r, base) {
  if (r._kind === "row") return r.role || "";
  return `[${r.role || ""}](${rel(r._path, base)})`;
}

function table(rs, base, cols = ["Date", "Company", "Role", "Status", "Fit", "Posting"]) {
  const out = ["| " + cols.join(" | ") + " |", "|" + "---|".repeat(cols.length)];
  for (const r of rs) {
    const vals = { Date: r.applied || r.updated || "", Company: cell(r.company), Role: linkCell(r, base),
      Status: r.status || "", Fit: r.location_fit || "", Posting: r.url ? `[link](${r.url})` : "",
      "Next step": cut(cell(section(r._body || "", "Notes")), 160) };
    out.push("| " + cols.map((c) => vals[c]).join(" | ") + " |");
  }
  return out;
}

export function cmdIndex(a, quiet = false) {
  const rs = rows();
  const since30 = daysAgo(30);
  const lines = ["# Applications", "", `Generated by \`scripts/seekter.mjs\` on ${TODAY}. Don't edit by hand.`, ""];
  const pend = rs.filter((r) => r.status === "pending");
  const live = rs.filter((r) => ["interviewing", "offer"].includes(r.status));
  const recent = rs.filter((r) => ["applied", "rejected", "closed"].includes(r.status) && (r.applied || r.updated || "") >= since30);
  lines.push(`## Needs you (${pend.length})`, "", "Forms waiting for a CAPTCHA, an account, a decision or an answer only you have.", "");
  lines.push(...(pend.length ? table(pend, APPS, ["Date", "Company", "Role", "Next step"]) : ["Nothing."]));
  lines.push("", `## In progress (${live.length})`, "");
  lines.push(...(live.length ? table(live, APPS) : ["Nothing yet."]));
  lines.push("", `## Sent in the last 30 days (${recent.length})`, "");
  lines.push(...(recent.length ? table(recent, APPS) : ["Nothing."]));
  lines.push("", "## By month", "", "| Month | Sent | Replies | Interviewing / offer | Pending | Skipped |", "|---|---|---|---|---|---|");
  const months = monthDirs();
  for (const d of [...months].reverse()) {
    const name = path.basename(d);
    const mr = rs.filter((r) => path.dirname(r._path) === d);
    const [c, sent] = counts(mr);
    lines.push(`| [${name}](${name}/README.md) | ${sent} | ${c.rejected + c.interviewing + c.offer} | ` +
      `${c.interviewing + c.offer} | ${c.pending} | [${c.skipped}](${name}/skipped.md) |`);
    // per-month page
    const ml = [`# ${name}`, "", `Generated by \`scripts/seekter.mjs\` on ${TODAY}.`, "",
      STATUSES.filter((s) => c[s]).map((s) => `**${s}** ${c[s]}`).join(" · "), ""];
    const files = mr.filter((r) => r._kind === "file");
    ml.push(...(files.length ? table(files, d) : ["No applications this month."]));
    ml.push("", `Skipped postings (${c.skipped}): [skipped.md](skipped.md)`, "");
    fs.writeFileSync(path.join(d, "README.md"), ml.join("\n"), "utf8");
  }
  const [c, sent] = counts(rs);
  lines.push("", `All time: **${sent} sent** · ` + STATUSES.filter((s) => c[s]).map((s) => `${s} ${c[s]}`).join(" · "), "");
  fs.mkdirSync(APPS, { recursive: true });
  fs.writeFileSync(path.join(APPS, "README.md"), lines.join("\n"), "utf8");
  if (!quiet) console.log(`applications/README.md (${rs.length} records, ${months.length} months)`);
  return 0;
}

// Move a v1 tracker (applications/<status>/*.md) to the month layout.
function cmdMigrate(a) {
  const old = STATUSES.map((s) => path.join(APPS, s)).filter(isDir);
  if (!old.length) die("nothing to migrate: no applications/<status>/ folders");
  let nFiles = 0, nRows = 0;
  for (const d of old) {
    for (const f of mdFiles(d)) {
      const r = read(path.join(d, f));
      const body = r._body;
      delete r._body; delete r._path; delete r._kind;
      r.status = r.status || path.basename(d);
      if (r.status === "skipped") {
        r.notes = section(body, "Notes") || section(body, "Why it fits");
        save(r);
        nRows++;
      } else {
        const date = r.applied || r.updated || f.slice(0, 10);
        fixMeta(r);
        write(path.join(APPS, monthOf(date), f), r, body);
        nFiles++;
      }
      if (!a.keep_old) fs.unlinkSync(path.join(d, f));
    }
    if (!a.keep_old) { try { fs.rmdirSync(d); } catch { /* not empty */ } }
  }
  cmdIndex(null);
  console.log(`migrated ${nFiles} files and ${nRows} skip rows` + (a.keep_old ? " (old folders kept)" : ""));
  return 0;
}

// ---------- argument parsing ----------
// A small argparse: positionals in order, `--name value`, `--name=value` and flags.
// Option names are matched exactly (no prefix abbreviations), and unknown ones are an error.
export function parseArgs(argv, spec) {
  const out = {};
  const pos = [];
  for (const [name, o] of Object.entries(spec.options || {})) out[name.replace(/-/g, "_")] = o.flag ? false : (o.default ?? null);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--") && t.length > 2) {
      const eq = t.indexOf("=");
      const name = eq >= 0 ? t.slice(2, eq) : t.slice(2);
      const o = (spec.options || {})[name];
      if (!o) die(`usage: ${spec.usage}\nerror: unrecognized arguments: ${t}`, 2);
      const key = name.replace(/-/g, "_");
      if (o.flag) { out[key] = true; continue; }
      if (eq >= 0) out[key] = t.slice(eq + 1);
      else {
        if (i + 1 >= argv.length) die(`usage: ${spec.usage}\nerror: argument --${name}: expected one argument`, 2);
        out[key] = argv[++i];
      }
    } else pos.push(t);
  }
  const names = spec.positional || [];
  if (pos.length < names.length) die(`usage: ${spec.usage}\nerror: the following arguments are required: ${names.slice(pos.length).join(", ")}`, 2);
  if (pos.length > names.length) die(`usage: ${spec.usage}\nerror: unrecognized arguments: ${pos.slice(names.length).join(" ")}`, 2);
  names.forEach((n, i) => { out[n] = pos[i]; });
  for (const [name, o] of Object.entries(spec.options || {})) {
    if (o.required && (out[name.replace(/-/g, "_")] === null)) die(`usage: ${spec.usage}\nerror: the following arguments are required: --${name}`, 2);
  }
  return out;
}

const s = (o = {}) => ({ default: "", ...o });
const COMMANDS = {
  check: { fn: cmdCheck, positional: ["url"], options: { company: { default: null } } },
  "check-many": { fn: cmdCheckMany },
  add: { fn: cmdAdd, options: {
    company: { required: true }, role: { required: true }, url: s(), status: s({ default: "applied" }),
    source: s(), ats: s(), "apply-type": s(), "location-fit": s(), "remote-scope": s(), fit: s(), posted: s(),
    applied: s(), date: s(), why: s(), notes: s(), answers: s(), log: s(), resume: s(),
    force: { flag: true }, "no-index": { flag: true } } },
  move: { fn: cmdMove, positional: ["target", "status"], options: { note: s(), answers: s() } },
  list: { fn: cmdList, options: { status: { default: null }, since: { default: null } } },
  index: { fn: (a) => cmdIndex(a) },
  normalize: { fn: cmdNormalize, options: { "dry-run": { flag: true } } },
  settings: { fn: cmdSettings, options: { check: { flag: true } } },
  stats: { fn: cmdStats, options: { since: { default: null }, by: { default: null }, min: { default: null }, floor: { default: null } } },
  migrate: { fn: cmdMigrate, options: { "keep-old": { flag: true } } },
};

const USAGE = "node scripts/seekter.mjs {" + Object.keys(COMMANDS).join(",") + "} ...";

// True when this file is the script node was asked to run, false when it is imported (a
// test, another script, `node -e` with arguments that are not files).
export function isMainModule(url) {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(url)); } catch { return false; }
}

export async function runMain(fn) {
  try {
    const code = await fn();
    process.exitCode = typeof code === "number" ? code : 0;
  } catch (e) {
    if (e instanceof Exit) {
      process.stderr.write(e.message + "\n");
      process.exitCode = e.code;
    } else throw e;
  }
}

// Text that comes from a posting or a form (a company, a role, the answers sent) must never be
// typed into a shell command: a role named `$(...)` or holding a backtick runs as a command the
// moment the line is pasted into a shell, and a heredoc is no fix, because a line equal to its
// delimiter closes it early. So every command also takes its arguments from a JSON file, written
// by the agent with its file tool: {"company": "...", "role": "...", "answers": "..."}. Positional
// arguments go by name ("url" for check, "target" and "status" for move); keys may use - or _.
// Anything else on the command line (--no-index, --force) still applies.
export function argsFromJson(file, spec) {
  let raw;
  try { raw = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8"); } catch (e) { die(`--json: cannot read ${file} (${e.code || e.message})`, 2); }
  let obj;
  // Windows PowerShell 5.1 writes UTF-8 with a byte-order mark, which JSON.parse rejects.
  try { obj = JSON.parse(raw.replace(/^\uFEFF/, "")); } catch (e) { die(`--json: ${file} is not valid JSON (${e.message})`, 2); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) die(`--json: ${file} must hold one JSON object`, 2);
  const names = spec.positional || [], options = spec.options || {};
  const pos = [], opts = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = k.replace(/_/g, "-");
    if (v === null || v === undefined || v === false) continue;
    if (names.includes(key)) continue;
    const o = options[key];
    if (!o) die(`--json: unknown field "${k}" for this command`, 2);
    if (o.flag) { if (v === true) opts.push(`--${key}`); continue; }
    if (typeof v === "object") die(`--json: "${k}" must be text or a number`, 2);
    opts.push(`--${key}`, String(v));
  }
  for (const n of names) {
    const v = obj[n] ?? obj[n.replace(/-/g, "_")];
    if (v === null || v === undefined) break;
    pos.push(String(v));
  }
  return [...pos, ...opts];
}

function main(argv) {
  let [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(`usage: ${USAGE}\n\nSeekter tracker. Commands: ${Object.keys(COMMANDS).join(", ")}.`);
    return cmd ? 0 : 2;
  }
  const spec = COMMANDS[cmd];
  if (!spec) die(`usage: ${USAGE}\nerror: invalid choice: '${cmd}'`, 2);
  const j = rest.indexOf("--json");
  if (j >= 0) {
    if (j + 1 >= rest.length) die(`usage: node scripts/seekter.mjs ${cmd} --json FILE`, 2);
    const fromFile = argsFromJson(rest[j + 1], spec);
    const others = [...rest.slice(0, j), ...rest.slice(j + 2)];
    if (others.some((t) => !t.startsWith("--"))) die("--json: give the positional arguments inside the file, not on the command line", 2);
    rest = [...fromFile, ...others];
  }
  const a = parseArgs(rest, { ...spec, usage: `node scripts/seekter.mjs ${cmd}` });
  return spec.fn(a);
}

if (isMainModule(import.meta.url)) {
  runMain(() => main(process.argv.slice(2)));
}
