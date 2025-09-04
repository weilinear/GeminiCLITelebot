#!/usr/bin/env python3
import os, threading, requests, base64, json
from dotenv import load_dotenv
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

load_dotenv()

SLACK_BOT_TOKEN = os.environ["SLACK_BOT_TOKEN"]
SLACK_APP_TOKEN = os.environ["SLACK_APP_TOKEN"]
GEMINI_ENDPOINT = os.getenv("GEMINI_ENDPOINT", "http://127.0.0.1:8765/event")
# Force http
if "https" in GEMINI_ENDPOINT:
    GEMINI_ENDPOINT = GEMINI_ENDPOINT.replace("https://", "http://")
TARGET_CHANNEL  = os.getenv("TARGET_CHANNEL", "").strip()
USE_BLOCKS      = os.getenv("SLACK_BLOCKS", "0") == "1"

assert SLACK_BOT_TOKEN.startswith("xoxb-")
assert SLACK_APP_TOKEN.startswith("xapp-")

app = App(token=SLACK_BOT_TOKEN)

auth = app.client.auth_test()
BOT_USER_ID = auth.get("user_id", "")
print(f"[boot] BOT_USER_ID={BOT_USER_ID} TARGET_CHANNEL={TARGET_CHANNEL!r} USE_BLOCKS={USE_BLOCKS}")

def download_file(client, file_id):
    try:
        info = client.files_info(file=file_id)
        file_data = info.get("file", {})
        if not file_data:
            return None, None, None, "Could not retrieve file info"

        file_url = file_data.get("url_private_download")
        filename = file_data.get("name", "unknown_file")
        mimetype = file_data.get("mimetype", "application/octet-stream")

        if not file_url:
            return None, None, None, "No download URL available"

        headers = {"Authorization": f"Bearer {SLACK_BOT_TOKEN}"}
        resp = requests.get(file_url, headers=headers, timeout=30)
        resp.raise_for_status()
        print(f"[file] downloaded {filename} ({len(resp.content)} bytes, mime={mimetype})")
        return resp.content, filename, mimetype, None
    except Exception as e:
        print(f"[file] download error: {e}")
        return None, None, None, str(e)

def call_gemini(prompt: str, context: str = "", file_content=None, filename=None, mimetype=None, blocks=False, timeout_ms=30000):
    try:
        payload = {
            "mode": "qa_blocks" if blocks else "qa",
            "text": prompt,
            "context": context or "",
            # ✅ sync only for text-only messages
            "sync": False if file_content else True,
            "timeout_ms": timeout_ms,
        }
        if file_content and filename:
            file_b64 = base64.b64encode(file_content).decode("utf-8")
            payload["attachments"] = [{
                "filename": filename,
                "mime": mimetype or "application/octet-stream",
                "data_base64": file_b64,
            }]

        r = requests.post(GEMINI_ENDPOINT, json=payload, timeout=(timeout_ms/1000.0 + 5))
        print(f"[gemini] POST {GEMINI_ENDPOINT} status={r.status_code}")
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print("[gemini] error:", e)
        return {"ok": False, "error": str(e)}

def fetch_thread_context(client, channel, thread_ts, limit=6):
    try:
        resp = client.conversations_replies(channel=channel, ts=thread_ts, limit=limit)
        msgs = resp.get("messages", [])
        print(f"[ctx] fetched {len(msgs)} msgs for thread_ts={thread_ts}")
        return msgs
    except Exception as e:
        print("[ctx] conversations_replies failed:", e)
        return []

def render_ctx(msgs):
    return "\n".join(
        f"<@{m.get('user','unknown')}>: {(m.get('text') or '').strip()}"
        for m in msgs if (m.get("text") or "").strip()
    )

@app.event("message")
def on_message(body, client, logger):
    event = body.get("event", {})
    subtype = event.get("subtype")
    user    = event.get("user")
    channel = event.get("channel")
    text    = (event.get("text") or "").strip()
    ts      = event.get("ts")
    thread_ts = event.get("thread_ts") or ts
    files   = event.get("files", [])

    if subtype in ['channel_join', 'channel_leave']:
        return
    if not user or user == BOT_USER_ID:
        return
    if TARGET_CHANNEL and channel != TARGET_CHANNEL:
        return

    def work():
        ctx_msgs  = fetch_thread_context(client, channel, thread_ts, limit=6)
        ctx_block = render_ctx(ctx_msgs)

        file_content = filename = mimetype = None
        if files:
            file_id = files[0].get("id")
            if file_id:
                file_content, filename, mimetype, error = download_file(client, file_id)
                if error:
                    client.chat_postMessage(channel=channel, text=f"❌ File error: {error}", thread_ts=thread_ts)
                    return

        # Build prompt
        if file_content:
            prompt = f"You are an assistant in Slack. The user shared a file.\n<@{user}>: {text}\nFile: {filename}\n"
        else:
            prompt = f"You are an assistant in Slack.\n<@{user}>: {text}\n"

        result = call_gemini(prompt, context=ctx_block, file_content=file_content,
                             filename=filename, mimetype=mimetype, blocks=USE_BLOCKS)
        
        try:
            # Text-only + sync path
            if isinstance(result, dict) and result.get("ok") and result.get("reply"):
                payload = result["reply"]  # {"text": "...", maybe "audio_path": "..."}
                reply_text = (payload.get("text") or "").strip()
                if not reply_text:
                    reply_text = "(no text)"
        
                if USE_BLOCKS and isinstance(result.get("blocks"), list):
                    app.client.chat_postMessage(
                        channel=channel,
                        thread_ts=thread_ts,
                        blocks=result["blocks"],
                        text=reply_text  # ✅ REQUIRED fallback
                    )
                    print("[send] posted block kit reply")
                else:
                    app.client.chat_postMessage(
                        channel=channel,
                        thread_ts=thread_ts,
                        text=reply_text
                    )
                    print("[send] posted text reply")
        
            else:
                # Async or error path
                err = ""
                if isinstance(result, dict):
                    err = result.get("error") or ""
                if file_content:
                    # Async by design when files are attached (see #3 below)
                    notice = "📎 Got your file—processing… I’ll reply here when it’s ready."
                elif err:
                    notice = f"❌ {err}"
                else:
                    notice = "Working…"
        
                app.client.chat_postMessage(
                    channel=channel,
                    thread_ts=thread_ts,
                    text=notice  # ✅ always provide text
                )
                print("[send] posted placeholder/notice")
        
        except Exception as e:
            print("[send] chat_postMessage failed:", e)

    threading.Thread(target=work, daemon=True).start()

# Other events just logged
@app.event("file_shared")
def handle_file_shared_events(body, logger): logger.info(body)
@app.event("file_public")
def handle_file_public_events(body, logger): logger.info(body)
@app.event("file_created")
def handle_file_created_events(body, logger): logger.info(body)
@app.event("file_change")
def handle_file_change_events(body, logger):
    logger.info(body)

@app.event("app_mention")
def on_mention(body, say, logger):
    event = body.get("event", {})
    say("Hi! I am listening 👋", thread_ts=event.get("thread_ts") or event.get("ts"))

if __name__ == "__main__":
    print("Starting Slack Bolt (Socket Mode)…")
    SocketModeHandler(app, SLACK_APP_TOKEN).start()