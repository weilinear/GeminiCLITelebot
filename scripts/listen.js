#!/usr/bin/env node
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

const port = Number(process.env.PORT || 8765);

/* -------------------- helpers -------------------- */

function runGemini(prompt) {
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

        // 1) Immediate ACK (within 3s)
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ response_type: "in_channel", text: "Working on it…" }));

        // 2) Background work + final post to response_url
        try {
          const reply = await runGemini(`Slack user @${user} in #${channel} asked:\n\n${text}`);
          postJSON(responseUrl, { text: reply });
          console.log("\n--- Gemini response (Slack) ---\n" + reply + "\n-------------------------------\n");
        } catch (e) {
          postJSON(responseUrl, { text: `❌ Error: ${e.message}` });
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
            postJSON(responseUrl, { ok: true, reply });
          }
          console.log("\n--- Gemini response (async) ---\n" + reply + "\n-------------------------------\n");
        } catch (e) {
          if (responseUrl) postJSON(responseUrl, { ok: false, error: String(e.message || e) });
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
