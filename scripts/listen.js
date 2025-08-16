#!/usr/bin/env node
const http = require("http");
const { spawn } = require("child_process");

const port = Number(process.argv[2] || process.env.PORT || 8765);

function runGemini(prompt) {
  return new Promise((resolve, reject) => {
    const p = spawn("gemini", ["--yolo", "--prompt", prompt], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("close", code => code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`)));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  if (req.method === "POST" && req.url === "/event") {
    try {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        let parsed;
        try { parsed = JSON.parse(body || "{}"); } catch { parsed = { raw: body || "" }; }

        const prompt = [
          "You are an ops agent receiving a webhook.",
          "Summarize the event and propose next actions.",
          "",
          "### Body",
          "```json",
          JSON.stringify(parsed, null, 2),
          "```"
        ].join("\n");

        const reply = await runGemini(prompt);
        const json = JSON.stringify({ ok: true, reply });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(json);
        console.log("\n--- Gemini response ---\n" + reply + "\n-----------------------\n");
      });
    } catch (e) {
      console.error(e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(port, () => {
  console.log(`Webhook listener on http://127.0.0.1:${port}/event`);
});
