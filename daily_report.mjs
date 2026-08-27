// daily_report.mjs – Daily digest: reads pre-computed LLM fields from reports
// -------------------------------------------------------------------
// No external API calls. The evaluation LLM already writes:
//   - why_great_for_you  (personalized match explanation)
//   - experience_delta   (required vs yours vs delta)
// into each report's ## Machine Summary YAML block.
// This script just reads them and builds the email.
// -------------------------------------------------------------------

import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

// Configurable threshold – override via env var DIGEST_SCORE_THRESHOLD
const SCORE_THRESHOLD = process.env.DIGEST_SCORE_THRESHOLD
  ? parseFloat(process.env.DIGEST_SCORE_THRESHOLD)
  : 4.0;

const reportsDir = path.resolve("reports");

// Append-only ledger of reports already sent, so a role is emailed once and
// the digest stays useful as reports/ accumulates. Seed it without sending
// via `node daily_report.mjs --seed`; re-send everything with --all.
const sentLedger = path.resolve("data", "digest-sent.tsv");

function loadSent() {
  if (!fs.existsSync(sentLedger)) return new Set();
  return new Set(
    fs
      .readFileSync(sentLedger, "utf8")
      .split("\n")
      .map((l) => l.split("\t")[0].trim())
      .filter(Boolean),
  );
}

function markSent(files) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = files.map((f) => `${f}\t${today}`).join("\n");
  fs.appendFileSync(sentLedger, rows + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// YAML field extractors (simple regex – good enough for the Machine Summary)
// ---------------------------------------------------------------------------

function extractField(text, field) {
  // Match a simple key: "value" or key: value (single line)
  const re = new RegExp(`^\\s*${field}:\\s*"?([^"\\n]+)"?`, "m");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function extractScore(text) {
  const m = text.match(/^\s*score:\s*([0-9.]+)/m);
  return m ? parseFloat(m[1]) : null;
}

function extractExperienceDelta(text) {
  // Grab the experience_delta block from the YAML
  const blockMatch = text.match(
    /experience_delta:\s*\n((?:\s+\w+:.*\n?)+)/
  );
  if (!blockMatch) return null;
  const block = blockMatch[1];
  const req = block.match(/required:\s*(\S+)/);
  const yours = block.match(/yours:\s*(\S+)/);
  const delta = block.match(/delta:\s*(\S+)/);
  const note = block.match(/note:\s*"([^"]+)"/);
  return {
    required: req ? (req[1] === "null" ? null : parseFloat(req[1])) : null,
    yours: yours ? parseFloat(yours[1]) : null,
    delta: delta ? (delta[1] === "null" ? null : parseFloat(delta[1])) : null,
    note: note ? note[1] : null,
  };
}

function extractCompany(text) {
  return extractField(text, "company") || "Unknown";
}

function extractRole(text) {
  return extractField(text, "role") || "Unknown";
}

function extractDecision(text) {
  return extractField(text, "final_decision") || "—";
}

function extractWhyGreat(text) {
  return extractField(text, "why_great_for_you") || "—";
}

function extractUrl(text) {
  // Match **URL:** https://... from the report header
  const m = text.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s]+)/i);
  return m ? m[1] : null;
}

function extractTopStrengths(text) {
  // Grab the top_strengths list items
  const block = text.match(/top_strengths:\s*\n((?:\s+-\s+"[^"]+"\n?)+)/);
  if (!block) return [];
  return [...block[1].matchAll(/- "([^"]+)"/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Load & filter reports
// ---------------------------------------------------------------------------

const alreadySent = loadSent();

const allReports = fs
  .readdirSync(reportsDir)
  .filter((f) => f.endsWith(".md") && !f.includes("RESERVED") && !f.startsWith("."))
  .map((f) => ({
    file: f,
    content: fs.readFileSync(path.join(reportsDir, f), "utf8"),
  }));

const qualified = allReports
  .map((r) => ({
    ...r,
    score: extractScore(r.content),
    company: extractCompany(r.content),
    role: extractRole(r.content),
    decision: extractDecision(r.content),
    whyGreat: extractWhyGreat(r.content),
    expDelta: extractExperienceDelta(r.content),
    strengths: extractTopStrengths(r.content),
    url: extractUrl(r.content),
  }))
  .filter((r) => r.score !== null && r.score >= SCORE_THRESHOLD)
  .filter((r) => process.argv.includes("--all") || !alreadySent.has(r.file))
  .sort((a, b) => b.score - a.score); // highest score first

if (process.argv.includes("--seed")) {
  const unsent = allReports.map((r) => r.file).filter((f) => !alreadySent.has(f));
  if (unsent.length) markSent(unsent);
  console.log(`🌱 Seeded ledger with ${unsent.length} existing report(s) — none emailed.`);
  process.exit(0);
}

if (qualified.length === 0) {
  console.log("No new reports met the threshold; skipping email.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Build HTML email – one unified table sorted by rank
// ---------------------------------------------------------------------------

let html = `<div style="font-family: 'Segoe UI', Tahoma, sans-serif; line-height: 1.6; max-width: 720px; margin: auto; padding: 20px;">`;

html += `<h2 style="color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px;">
  📈 Daily Digest — ${qualified.length} role${qualified.length > 1 ? "s" : ""} above ${SCORE_THRESHOLD}
</h2>`;

// Unified table
html += `<table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">`;
html += `<thead><tr style="background: #2c3e50; color: #fff; text-align: left;">
  <th style="padding: 8px; width: 30px;">#</th>
  <th style="padding: 8px;">Company</th>
  <th style="padding: 8px;">Role</th>
  <th style="padding: 8px; width: 50px;">Score</th>
  <th style="padding: 8px; width: 65px;">Decision</th>
  <th style="padding: 8px; width: 80px;">Exp Δ</th>
</tr></thead><tbody>`;

qualified.forEach((r, i) => {
  const bg = i % 2 === 0 ? "#f9f9f9" : "#ffffff";
  const reportNum = r.file.match(/^(\d+)/)?.[1] || "—";

  // Experience delta badge
  let expBadge = "—";
  if (r.expDelta) {
    if (r.expDelta.required === null) {
      expBadge = `<span style="color:#7f8c8d;">not stated</span>`;
    } else if (r.expDelta.delta !== null) {
      const color = r.expDelta.delta >= 0 ? "#27ae60" : "#e74c3c";
      const sign = r.expDelta.delta >= 0 ? "+" : "";
      expBadge = `<span style="color:${color}; font-weight:bold;">${sign}${r.expDelta.delta}y</span>`;
      expBadge += `<br/><span style="font-size:0.8em; color:#999;">${r.expDelta.required}y req / ${r.expDelta.yours}y yours</span>`;
    }
  }

  // Decision color
  const decisionColors = {
    Apply: "#27ae60",
    Consider: "#f39c12",
    "Research first": "#e67e22",
    Skip: "#e74c3c",
  };
  const decColor = decisionColors[r.decision] || "#333";

  html += `<tr style="background:${bg}; border-bottom: 1px solid #eee;">
    <td style="padding: 8px; text-align: center; color: #999;">${reportNum}</td>
    <td style="padding: 8px; font-weight: bold;">${r.company}</td>
    <td style="padding: 8px;">${r.url ? `<a href="${r.url}" style="color: #2c3e50; text-decoration: underline;">${r.role}</a>` : r.role}</td>
    <td style="padding: 8px; text-align: center;"><span style="color: #e67e22; font-weight: bold;">${r.score}</span></td>
    <td style="padding: 8px;">${r.url && (r.decision === "Apply" || r.decision === "Consider") ? `<a href="${r.url}" style="display:inline-block; padding:4px 10px; background:${decColor}; color:#fff; border-radius:4px; text-decoration:none; font-weight:bold; font-size:0.85em;">${r.decision}</a>` : `<span style="color:${decColor}; font-weight:bold;">${r.decision}</span>`}</td>
    <td style="padding: 8px; text-align: center;">${expBadge}</td>
  </tr>`;

  // "Why great for you" row spanning the full table
  if (r.whyGreat !== "—") {
    html += `<tr style="background:${bg};">
      <td style="padding: 2px 8px 10px 8px;" colspan="6">
        <span style="font-size: 0.85em; color: #2c3e50;">
          <strong>Why:</strong> ${r.whyGreat}
        </span>
      </td>
    </tr>`;
  }
});

html += `</tbody></table>`;

// Footer
html += `<p style="font-size: 0.8em; color: #7f8c8d; margin-top: 30px;">
  Automated digest · Threshold: ${SCORE_THRESHOLD} · ${new Date().toLocaleDateString()} · career-ops
</p>`;
html += `</div>`;

// ---------------------------------------------------------------------------
// Send email or dry-run preview
// ---------------------------------------------------------------------------

const isDryRun = process.argv.includes("--dry-run");

if (isDryRun) {
  const outDir = path.resolve("output");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "digest-preview.html");
  fs.writeFileSync(outFile, html, "utf8");
  console.log(`🔍 Dry-run — HTML preview written to ${outFile}`);
  console.log(`   ${qualified.length} roles above ${SCORE_THRESHOLD}`);
} else {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: `"Career-Ops Digest" <${process.env.SMTP_USER}>`,
    to: process.env.SMTP_TO,
    subject: `Daily Job Digest — ${qualified.length} roles above ${SCORE_THRESHOLD} (${new Date().toLocaleDateString()})`,
    html,
  });

  markSent(qualified.map((r) => r.file));
  console.log(`✅ Digest sent to ${process.env.SMTP_TO} — ${qualified.length} roles`);
}
