// Per-application review and single-use approval, stored only in git-ignored runs/.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ROOT, allApps, jobKey } from "./seekter.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const dir = (root, kind) => path.join(root, "runs", kind);

export function reviewId(url) {
  const key = jobKey(url);
  if (!key) throw new Error("A posting URL with a job identity is required");
  return hash(key);
}

function file(root, kind, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid review ID");
  return path.join(dir(root, kind), `${id}.json`);
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function pairs(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${name} entries must be objects`);
    const label = String(item.label ?? item.question ?? "").trim();
    const answer = String(item.value ?? item.answer ?? "").trim();
    if (!label || !answer) throw new Error(`${name} entries need a label and value`);
    return { label, value: answer };
  });
}

export function normalizeReview(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Review must be an object");
  const company = String(input.company ?? "").trim();
  const role = String(input.role ?? "").trim();
  const url = String(input.url ?? "").trim();
  const cv = String(input.cv ?? "").trim();
  if (!company || !role || !cv) throw new Error("Review needs company, role and CV path");
  if (!/^https?:$/.test(new URL(url).protocol)) throw new Error("Review URL must use HTTP(S)");
  reviewId(url);
  const fields = pairs(input.fields, "fields");
  if (!fields.length) throw new Error("Review needs the exact filled contact and screening fields");
  return { company, role, url, cv, fields, answers: pairs(input.answers ?? [], "answers"),
    consents: pairs(input.consents ?? [], "consents"), notes: String(input.notes ?? "").trim() };
}

export function putReview(root, input) {
  const review = normalizeReview(input);
  const id = reviewId(review.url);
  const contentHash = hash(JSON.stringify(review));
  const revision = hash(JSON.stringify(review) + crypto.randomUUID());
  writeJson(file(root, "reviews", id), { ...review, id, contentHash, revision, preparedAt: now() });
  return { id, revision };
}

export function getReview(root, id) { return readJson(file(root, "reviews", id)); }

export function approvalStatus(root, id) {
  const review = getReview(root, id);
  if (!review) return "no_review";
  const decision = readJson(file(root, "approvals", id));
  if (!decision || decision.revision !== review.revision) return "awaiting_approval";
  return decision.state;
}

export function decideReview(root, id, state) {
  if (!["approved", "declined", "revoked"].includes(state)) throw new Error("Invalid decision");
  const review = getReview(root, id);
  if (!review) throw new Error("Review not found");
  if (state === "approved" && approvalStatus(root, id) === "claimed") {
    throw new Error("Prepare a new review before approving a retry");
  }
  writeJson(file(root, "approvals", id), { revision: review.revision, state, at: now() });
  return state;
}

export function claimApproval(root, url, input = null) {
  const id = reviewId(url);
  const review = getReview(root, id);
  if (!review || jobKey(review.url) !== jobKey(url)) throw new Error("No matching review");
  if (input && hash(JSON.stringify(normalizeReview(input))) !== review.contentHash) {
    throw new Error("Review file changed; prepare and approve the new version");
  }
  const decision = readJson(file(root, "approvals", id));
  if (!decision || decision.revision !== review.revision || decision.state !== "approved") {
    throw new Error("No current, unused approval for this application");
  }
  writeJson(file(root, "approvals", id), { ...decision, state: "claimed", claimedAt: now() });
  return review;
}

function assertPending(url) {
  const key = jobKey(url);
  if (!allApps().some((row) => row.job_key === key && row.status === "pending")) {
    throw new Error("Application must be pending in the tracker");
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, flag, filename] = process.argv.slice(2);
    if (!filename || flag !== "--json") throw new Error("Usage: node scripts/review.mjs {put,status,approve,decline,revoke,claim} --json FILE");
    const input = JSON.parse(fs.readFileSync(filename, "utf8"));
    assertPending(input.url);
    const id = reviewId(input.url);
    if (command === "put") console.log(JSON.stringify(putReview(ROOT, input)));
    else if (command === "status") console.log(approvalStatus(ROOT, id));
    else if (["approve", "decline", "revoke"].includes(command)) {
      console.log(decideReview(ROOT, id, { approve: "approved", decline: "declined", revoke: "revoked" }[command]));
    } else if (command === "claim") {
      const review = claimApproval(ROOT, input.url, input);
      console.log(`approval claimed for ${review.company} — ${review.role}`);
    } else throw new Error("Unknown review command");
  } catch (error) { console.error(`problem: ${error.message}`); process.exitCode = 1; }
}
