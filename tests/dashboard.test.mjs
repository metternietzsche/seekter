import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDashboardServer } from "../scripts/dashboard.mjs";
import { approvalStatus, claimApproval, decideReview, putReview, reviewId } from "../scripts/review.mjs";

const posting = "https://jobs.ashbyhq.com/example/1e548ada-1111-2222-3333-444455556666";
const draft = () => ({ company: "Example", role: "Product designer", url: posting,
  cv: "profile/documents/cv.pdf", fields: [{ label: "Email", value: "candidate@example.com" }],
  answers: [{ label: "Why this role?", value: "I built a design system." }],
  consents: [{ label: "Application privacy notice", value: "Yes" }] });

test("approval is tied to one review and can be claimed once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seekter-review-"));
  try {
    const review = draft();
    const { id } = putReview(root, review);
    assert.equal(id, reviewId(posting));
    assert.equal(approvalStatus(root, id), "awaiting_approval");
    decideReview(root, id, "approved");
    assert.equal(approvalStatus(root, id), "approved");
    assert.equal(claimApproval(root, posting, review).company, "Example");
    assert.equal(approvalStatus(root, id), "claimed");
    assert.throws(() => claimApproval(root, posting, review), /unused approval/);
    assert.throws(() => decideReview(root, id, "approved"), /new review/);
    putReview(root, review);
    assert.equal(approvalStatus(root, id), "awaiting_approval");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("changed answers invalidate approval and a decline cannot be claimed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seekter-review-"));
  try {
    const review = draft();
    const { id } = putReview(root, review);
    decideReview(root, id, "approved");
    const changed = draft();
    changed.answers[0].value = "A different answer.";
    assert.throws(() => claimApproval(root, posting, changed), /Review file changed/);
    putReview(root, changed);
    assert.equal(approvalStatus(root, id), "awaiting_approval");
    decideReview(root, id, "declined");
    assert.throws(() => claimApproval(root, posting, changed), /unused approval/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("dashboard serves locally and rejects cross-origin writes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seekter-board-"));
  const row = { company: "Example", role: "Product designer", url: posting, status: "pending",
    updated: "2026-10-31", _path: path.join(root, "applications", "draft.md"), _body: "" };
  const { id } = putReview(root, draft());
  const moves = [];
  const server = createDashboardServer({ root, getRows: () => [row], move: (value) => moves.push(value) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Control de candidaturas/);
    const state = await fetch(`${base}/api/state`);
    assert.equal(state.status, 200);
    const data = await state.json();
    assert.equal(data.rows[0].review.company, "Example");
    const blocked = await fetch(`${base}/api/decision`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.com", "X-CSRF-Token": "wrong" },
      body: JSON.stringify({ id: "0".repeat(64), decision: "approved" }) });
    assert.equal(blocked.status, 403);
    const approved = await fetch(`${base}/api/decision`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "X-CSRF-Token": data.csrf },
      body: JSON.stringify({ id, decision: "approved" }) });
    assert.equal(approved.status, 200);
    assert.equal(approvalStatus(root, id), "approved");
    const moved = await fetch(`${base}/api/stage`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "X-CSRF-Token": data.csrf },
      body: JSON.stringify({ id, status: "interviewing", note: "Recruiter called" }) });
    assert.equal(moved.status, 200);
    assert.equal(moves[0].status, "interviewing");
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});
