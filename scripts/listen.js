#!/usr/bin/env node
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const port = Number(process.env.PORT || 8765);

/* -------------------- config & helpers -------------------- */

// Slack cosmetics (used when posting back via response_url)
const SLACK_BOT_USERNAME = process.env.SLACK_BOT_USERNAME || "Webhook Assistant";
const SLACK_BOT_ICON_URL = process.env.SLACK_BOT_ICON_URL || "";
const SLACK_BOT_ICON_EMOJI = process.env.SLACK_BOT_ICON_EMOJI || ":robot_face:";

// Logging
const MAX_LOG_BYTES = Number(process.env.MAX_LOG_BYTES || 4096);
const LOG_HEADERS   = process.env.LOG_HEADERS === "1";
const LOG_BODY      = process.env.LOG_BODY === "1";

// Attachment guardrails
const ATTACH_MAX_FILES = Number(process.env.ATTACH_MAX_FILES || 6);
const ATTACH_MAX_BYTES = Number(process.env.ATTACH_MAX_BYTES || 50 * 1024 * 1024); // 50 MB per file

// Gemini knobs
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 60000);
const GEMINI_SYSTEM_PATH = process.env.GEMINI_SYSTEM || "/home/johncapobianco/.gemini/GEMINI.md";

// Load system prompt once (optional)
let SYSTEM_TEXT = "";
try {
  if (GEMINI_SYSTEM_PATH && fs.existsSync(GEMINI_SYSTEM_PATH)) {
    SYSTEM_TEXT = fs.readFileSync(GEMINI_SYSTEM_PATH, "utf8").trim();
    console.log(`[init] Loaded system prompt from ${GEMINI_SYSTEM_PATH} (${SYSTEM_TEXT.length} chars)`);
  }
} catch (e) {
  console.warn(`[init] Could not read system file: ${e.message}`);
}

const color = {
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  mag:    (s) => `\x1b[35m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function truncate(str, max = MAX_LOG_BYTES) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n… (${str.length - max} more bytes truncated)`;
}
function safeJson(obj) { try { return JSON.stringify(obj, null, 2); } catch { return String(obj); } }
function redactHeaders(h) {
  const clone = { ...h };
  for (const k of Object.keys(clone)) {
    if (/authorization|token|cookie|set-cookie|api[-_]key/i.test(k)) clone[k] = "[redacted]";
  }
  return clone;
}

const isPcap = (fname = "") => /\.pcap(?:ng)?$/i.test(fname);

/** Spawn Gemini CLI with timeout; return { stdout, stderr, code }. */
function runGeminiProcess(args) {
  return new Promise((resolve) => {
    const p = spawn("gemini", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";

    const to = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch {}
      resolve({ stdout: out.trim(), stderr: (err.trim() + " [timeout]"), code: 124 });
    }, GEMINI_TIMEOUT_MS).unref();

    p.stdout.on("data", d => (out += d.toString()));
    p.stderr.on("data", d => (err += d.toString()));
    p.on("close", code => {
      clearTimeout(to);
      resolve({ stdout: out.trim(), stderr: err.trim(), code });
    });
  });
}

/** Compose final prompt (prepend system text if present). */
function composePrompt(taskPrompt) {
  if (SYSTEM_TEXT) {
    return ["### System", SYSTEM_TEXT, "", "### Task", taskPrompt].join("\n");
  }
  return taskPrompt;
}

/** Summarize local files without inlining bytes. */
function listLocalFiles(saved) {
  if (!saved.length) return "";
  const lines = ["### Local files (available in current working directory)", ""];
  for (const f of saved) {
    lines.push(`- ${f.filename} (${f.bytes} bytes, ${f.mime || "application/octet-stream"})`);
  }
  lines.push(
    "",
    "You can open/read these files directly from the working directory to answer.",
    ""
  );
  return lines.join("\n");
}

/**
 * Build a Q&A prompt.
 * No base64 embedding. Just pass user’s text + optional context + a list of local files.
 */
function buildQAPrompt(userText, context, saved) {
  const lines = ["You are a helpful assistant. Be clear and concise."];
  if (context) lines.push("", "### Context", context);
  lines.push("", "### Question", userText || "(no text)");
  if (saved.length) lines.push("", listLocalFiles(saved));
  return lines.join("\n");
}

/** Build an ops-style prompt (no embedding). */
function buildOpsPrompt(obj, headers, saved, userTextForOps = "") {
  const lines = [
    "You are an assistant receiving a webhook. Summarize the event and suggest next steps.",
    "",
    "### Headers",
    "```json",
    safeJson(LOG_HEADERS ? headers : redactHeaders(headers)),
    "```",
    "",
    "### Body",
    "```json",
    safeJson(LOG_BODY ? obj : { ...obj, raw: undefined }),
    "```",
  ];
  if (saved.length) lines.push("", listLocalFiles(saved));
  if (userTextForOps) {
    lines.push("### Request", userTextForOps, "");
  }
  return lines.join("\n");
}

/** Just pass the composed prompt to gemini; do NOT inline file bytes; gemini reads local files. */
async function runGemini(taskPrompt) {
  const finalPrompt = composePrompt(taskPrompt);

  console.log(color.mag("→ Prompt to model:"));
  console.log(color.dim(truncate(finalPrompt)));

  const args = ["--yolo", "--prompt", finalPrompt];
  const res = await runGeminiProcess(args);

  if (res.code === 0) return res.stdout;
  throw new Error(res.stderr || `gemini exit ${res.code}`);
}

function sanitizeFilename(name) {
  return (name || "upload.bin").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
}
function uniquify(baseDir, fname) {
  let p = path.join(baseDir, fname);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(fname);
  const stem = path.basename(fname, ext);
  let i = 1;
  while (true) {
    const trial = path.join(baseDir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(trial)) return trial;
    i++;
  }
}

/**
 * Decode attachments from JSON and write them into CWD.
 * Expects: parsed.attachments: [{ filename, mime, data_base64 }]
 * Returns: [{ absPath, bytes, mime, filename }]
 */
function materializeAttachmentsInCWD(parsed) {
  const saved = [];
  const baseDir = process.cwd();
  const atts = Array.isArray(parsed?.attachments) ? parsed.attachments.slice(0, ATTACH_MAX_FILES) : [];
  for (const att of atts) {
    try {
      const fname = sanitizeFilename(att.filename || "upload.bin");
      const b64   = att.data_base64 || "";
      if (!b64) continue;
      const buf   = Buffer.from(b64, "base64");
      if (buf.length > ATTACH_MAX_BYTES) {
        console.warn(`[attach] skip ${fname}: ${buf.length} > ${ATTACH_MAX_BYTES}`);
        continue;
      }
      const dest = uniquify(baseDir, fname);
      fs.writeFileSync(dest, buf);
      const rec = {
        absPath: path.resolve(dest),
        bytes: buf.length,
        mime: att.mime || "application/octet-stream",
        filename: path.basename(dest),
      };
      saved.push(rec);
      console.log(`[attach] wrote ${rec.absPath} (${rec.bytes} bytes, ${rec.mime})`);
    } catch (e) {
      console.error("[attach] failed to write attachment:", e);
    }
  }
  return saved;
}

// Simple POST JSON
function postJSON(url, payload) {
  const data = JSON.stringify(payload);
  const u = new URL(url);
  const opts = {
    method: "POST",
    hostname: u.hostname,
    path: u.pathname + u.search,
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
  };
  const client = u.protocol === "http:" ? http : https;
  const req = client.request(opts, () => {});
  req.on("error", e => console.error("postJSON error:", e.message));
  req.write(data);
  req.end();
}

/** Post to Slack response_url with name/icon + visibility. */
function postSlack(responseUrl, text, visibility = "in_channel", options = {}) {
  const payload = { response_type: visibility, text, username: SLACK_BOT_USERNAME };
  if (SLACK_BOT_ICON_URL) payload.icon_url = SLACK_BOT_ICON_URL;
  else if (SLACK_BOT_ICON_EMOJI) payload.icon_emoji = SLACK_BOT_ICON_EMOJI;
  for (const k of ["thread_ts","blocks","attachments","replace_original","delete_original","unfurl_links","unfurl_media"]) {
    if (options[k] !== undefined) payload[k] = options[k];
  }
  postJSON(responseUrl, payload);
}

/* -------------------- server -------------------- */

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  if (req.method === "POST" && req.url.startsWith("/event")) {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", async () => {
      const ct = (req.headers["content-type"] || "").toLowerCase();

      // Slack slash command (form-encoded)
      if (ct.includes("application/x-www-form-urlencoded")) {
        const params = new URLSearchParams(raw);
        const text = params.get("text") || "";
        const user = params.get("user_name") || "";
        const channel = params.get("channel_name") || "";
        const responseUrl = params.get("response_url");
        const threadTs = params.get("thread_ts");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ response_type: "ephemeral", text: "Working on it…" }));

        try {
          const reply = await runGemini(`Slack user @${user} in #${channel} asked:\n\n${text}`);
          postSlack(responseUrl, reply, "in_channel", { thread_ts: threadTs || undefined, unfurl_links: false, unfurl_media: false });
        } catch (e) {
          postSlack(responseUrl, `❌ Error: ${e.message}`, "ephemeral", { thread_ts: threadTs || undefined });
        }
        return;
      }

      // Generic JSON webhook (from Bolt)
      let parsed;
      try {
        parsed = ct.includes("application/json") ? JSON.parse(raw || "{}") : { raw };
      } catch (e) {
        console.error(color.red("[json] parse error:"), e);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, reply: "❌ Invalid JSON payload." }));
      }

      // Materialize attachments to CWD
      const saved = materializeAttachmentsInCWD(parsed);

      // Async semantics (response_url or Prefer: respond-async or ?async=1)
      const responseUrl =
        (parsed && typeof parsed === "object" && parsed.response_url) ||
        (parsed && parsed.slack && parsed.slack.response_url) ||
        null;
      const url = new URL(req.url, `http://${req.headers.host}`);
      const forceAsync = url.searchParams.get("async") === "1" ||
        (req.headers["prefer"] || "").toLowerCase().includes("respond-async");
      const mode = (parsed && parsed.mode) || url.searchParams.get("mode") || "";

      // Build prompt AFTER attachments are known (no inlining)
      let prompt;
      if (mode === "qa") {
        const userText = (parsed && parsed.text) || "";
        const context  = (parsed && parsed.context) || "";
        prompt = buildQAPrompt(userText, context, saved);
      } else {
        const requestText = parsed?.text || "";
        prompt = buildOpsPrompt(parsed, req.headers, saved, requestText);
      }

      const doWork = async () => {
        try {
          const reply = await runGemini(prompt);
          return { ok: true, reply };
        } catch (e) {
          const msg = String(e.message || e);
          console.error(color.red(`[gemini] error: ${msg}`));
          const reply =
            `❌ Processing failed.\n\nDetails:\n${truncate(msg, 2000)}\n\n` +
            `Tips:\n• Ensure the local files exist in the working directory (names listed above)\n` +
            `• Ensure your Gemini CLI/tools can read local files when asked\n`;
          return { ok: false, reply };
        }
      };

      if (responseUrl || forceAsync) {
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, status: "accepted", note: "Processing asynchronously" }));

        const result = await doWork();
        const text = result.reply;
        if (responseUrl) {
          try {
            const u = new URL(responseUrl);
            if (u.hostname.endsWith("slack.com")) {
              postSlack(responseUrl, text, result.ok ? "in_channel" : "ephemeral", { unfurl_links: false, unfurl_media: false });
            } else {
              postJSON(responseUrl, { ok: result.ok, reply: text });
            }
          } catch {
            postJSON(responseUrl, { ok: result.ok, reply: text });
          }
        }
        return;
      }

      // Sync response (always 200)
      const result = await doWork();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: result.ok, reply: result.reply }));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(port, () => {
  console.log(`Webhook listener on http://127.0.0.1:${port}/event`);
});

process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down…");
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
});
