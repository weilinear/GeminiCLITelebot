#!/usr/bin/env node
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

const port = Number(process.env.PORT || 8765);

/* -------------------- helpers -------------------- */

// Defaults for Slack identity (override with env vars if you like)
const SLACK_BOT_USERNAME = process.env.SLACK_BOT_USERNAME || "Selector Packet Copilot";
const SLACK_BOT_ICON_URL = process.env.SLACK_BOT_ICON_URL || "";      // e.g. https://your.cdn/icon.png
const SLACK_BOT_ICON_EMOJI = process.env.SLACK_BOT_ICON_EMOJI || ":robot_face:";

const MAX_LOG_BYTES = Number(process.env.MAX_LOG_BYTES || 4096);
const LOG_HEADERS   = process.env.LOG_HEADERS === "1";
const LOG_BODY      = process.env.LOG_BODY === "1";

const color = {
  dim:  (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  mag:  (s) => `\x1b[35m${s}\x1b[0m`,
  yellow:(s)=> `\x1b[33m${s}\x1b[0m`,
  green:(s)=> `\x1b[32m${s}\x1b[0m`,
  red:  (s) => `\x1b[31m${s}\x1b[0m`,
};

function stringify(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}
function truncate(str, max = MAX_LOG_BYTES) {
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n… (${str.length - max} more bytes truncated)`;
}
function redactHeaders(h) {
  const clone = { ...h };
  for (const k of Object.keys(clone)) {
    if (/authorization|token|cookie|set-cookie|api[-_]key/i.test(k)) {
      clone[k] = "[redacted]";
    }
  }
  return clone;
}

function runGemini(prompt) {
  console.log(color.mag("→ Gemini prompt:"));
  console.log(color.dim(truncate(prompt)));
  return new Promise((resolve, reject) => {
    const p = spawn("gemini", ["--yolo", "--prompt", prompt], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => (out += d.toString()));
    p.stderr.on("data", d => (err += d.toString()));
    p.on("close", code => (code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`))));
  });
}

function postJSON(url, payload) {
  const data = JSON.stringify(payload);
  const u = new URL(url);
  const opts = {
    method: "POST",
    hostname: u.hostname,
    path: u.pathname + u.search,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data)
    }
  };
  const req = (u.protocol === "http:" ? http : https).request(opts, () => {});
  req.on("error", e => console.error("postJSON error:", e.message));
  req.write(data);
  req.end();
}

/**
 * Post to Slack response_url with name/icon + visibility.
 * visibility: "ephemeral" | "in_channel"
 * options can include: thread_ts, blocks, attachments, replace_original, delete_original, unfurl_links, unfurl_media
 */
function postSlack(responseUrl, text, visibility = "in_channel", options = {}) {
  const payload = {
    response_type: visibility,
    text,
    username: SLACK_BOT_USERNAME,
  };

  // prefer icon_url if provided, else use emoji
  if (SLACK_BOT_ICON_URL) {
    payload.icon_url = SLACK_BOT_ICON_URL;
  } else if (SLACK_BOT_ICON_EMOJI) {
    payload.icon_emoji = SLACK_BOT_ICON_EMOJI;
  }

  // copy selected optional fields if present
  const passthrough = [
    "thread_ts",
    "blocks",
    "attachments",
    "replace_original",
    "delete_original",
    "unfurl_links",
    "unfurl_media"
  ];
  for (const k of passthrough) {
    if (options[k] !== undefined) payload[k] = options[k];
  }

  postJSON(responseUrl, payload);
}

function buildOpsPrompt(obj, headers) {
  return [
    "You are an ops agent receiving a webhook.",
    "Summarize the event and propose next actions.",
    "",
    "### Headers",
    "```json",
    JSON.stringify(headers || {}, null, 2),
    "```",
    "",
    "### Body",
    "```json",
    JSON.stringify(obj, null, 2),
    "```"
  ].join("\n");
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

      // ---- Slack slash command (form-encoded) ----
      if (ct.includes("application/x-www-form-urlencoded")) {
        const params = new URLSearchParams(raw);
        const text = params.get("text") || "";
        const user = params.get("user_name") || "";
        const channel = params.get("channel_name") || "";
        const responseUrl = params.get("response_url");
        const threadTs = params.get("thread_ts"); // if command invoked in a thread

        // 1) Immediate ACK (within 3s) — keep private to avoid channel spam
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ response_type: "ephemeral", text: "Working on it…" }));

        // 2) Background work + final post to response_url (make public, include icon/name)
        try {
          const reply = await runGemini(`Slack user @${user} in #${channel} asked:\n\n${text}`);
          postSlack(responseUrl, reply, "in_channel", {
            thread_ts: threadTs || undefined,
            unfurl_links: false,
            unfurl_media: false
          });
          console.log("\n--- Gemini response (Slack) ---\n" + reply + "\n-------------------------------\n");
        } catch (e) {
          postSlack(responseUrl, `❌ Error: ${e.message}`, "ephemeral", {
            thread_ts: threadTs || undefined
          });
        }
        return;
      }

      // ---- Generic JSON webhook / curl ----
      let parsed;
      try {
        parsed = ct.includes("application/json") ? JSON.parse(raw || "{}") : { raw };
      } catch {
        parsed = { raw };
      }

      // If caller provided a response_url, do the same async pattern.
      const responseUrl =
        (parsed && typeof parsed === "object" && parsed.response_url) ||
        (parsed && parsed.slack && parsed.slack.response_url) ||
        null;

      // Optional: allow forcing async via header or query (?async=1)
      const url = new URL(req.url, `http://${req.headers.host}`);
      const forceAsync = url.searchParams.get("async") === "1" ||
        (req.headers["prefer"] || "").toLowerCase().includes("respond-async");

      const prompt = buildOpsPrompt(parsed, req.headers);

      if (responseUrl || forceAsync) {
        // Immediate ACK, then background post
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, status: "accepted", note: "Processing asynchronously" }));

        try {
          const reply = await runGemini(prompt);
          if (responseUrl) {
            // If it's Slack's response_url, send as public message with icon/name; otherwise plain JSON
            try {
              const u = new URL(responseUrl);
              if (u.hostname.endsWith("slack.com")) {
                postSlack(responseUrl, reply, "in_channel", { unfurl_links: false, unfurl_media: false });
              } else {
                postJSON(responseUrl, { ok: true, reply });
              }
            } catch {
              postJSON(responseUrl, { ok: true, reply });
            }
          }
          console.log("\n--- Gemini response (async) ---\n" + reply + "\n-------------------------------\n");
        } catch (e) {
          if (responseUrl) {
            try {
              const u = new URL(responseUrl);
              if (u.hostname.endsWith("slack.com")) {
                postSlack(responseUrl, `❌ Error: ${String(e.message || e)}`, "ephemeral");
              } else {
                postJSON(responseUrl, { ok: false, error: String(e.message || e) });
              }
            } catch {
              postJSON(responseUrl, { ok: false, error: String(e.message || e) });
            }
          }
        }
        return;
      }

      // Synchronous path (curl/Streamlit/etc) – returns the Gemini output directly
      try {
        const reply = await runGemini(prompt);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, reply }));
        console.log("\n--- Gemini response (sync) ---\n" + reply + "\n------------------------------\n");
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(port, () => {
  console.log(`Webhook listener on http://127.0.0.1:${port}/event`);
});

// Graceful shutdown (Esc in Gemini CLI will send SIGINT)
process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down…");
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
  // Safety: force-exit if close hangs
  setTimeout(() => process.exit(0), 1500).unref();
});
