#!/usr/bin/env python3
import os, threading, requests, base64
from dotenv import load_dotenv
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

load_dotenv()

SLACK_BOT_TOKEN = os.environ["SLACK_BOT_TOKEN"]
SLACK_APP_TOKEN = os.environ["SLACK_APP_TOKEN"]
GEMINI_ENDPOINT = os.getenv("GEMINI_ENDPOINT", "http://127.0.0.1:8765/event")
# Force http, based on user feedback
if "https" in GEMINI_ENDPOINT:
    GEMINI_ENDPOINT = GEMINI_ENDPOINT.replace("https://", "http://")
TARGET_CHANNEL  = os.getenv("TARGET_CHANNEL", "").strip()   # optional

assert SLACK_BOT_TOKEN.startswith("xoxb-")
assert SLACK_APP_TOKEN.startswith("xapp-")

app = App(token=SLACK_BOT_TOKEN)

auth = app.client.auth_test()
BOT_USER_ID = auth.get("user_id", "")
print(f"[boot] BOT_USER_ID={BOT_USER_ID} TARGET_CHANNEL={TARGET_CHANNEL!r}")

def download_file(client, file_id):
    """Download file content from Slack; returns (content, filename, mimetype, error)."""
    try:
        info = client.files_info(file=file_id)
        file_data = info.get("file", {})
        if not file_data:
            return None, None, None, "Could not retrieve file info"

        file_url = file_data.get("url_private_download")
        filename = file_data.get("name", "unknown_file")
        filetype = file_data.get("filetype", "unknown")
        mimetype = file_data.get("mimetype", "application/octet-stream")

        if not file_url:
            return None, None, None, "No download URL available"

        headers = {"Authorization": f"Bearer {SLACK_BOT_TOKEN}"}
        resp = requests.get(file_url, headers=headers, timeout=30)
        resp.raise_for_status()

        print(f"[file] downloaded {filename} ({len(resp.content)} bytes, type={filetype}, mimetype={mimetype})")
        return resp.content, filename, mimetype, None

    except Exception as e:
        print(f"[file] download error: {e}")
        return None, None, None, str(e)

def call_gemini(
    prompt: str,
    context: str = "",
    file_content: bytes = None,
    filename: str = None,
    mimetype: str = None,
) -> str:
    try:
        payload = {"mode": "qa", "text": prompt}
        if context:
            payload["context"] = context

        if file_content and filename:
            file_b64 = base64.b64encode(file_content).decode("utf-8")
            payload["attachments"] = [{
                "filename": filename,
                "mime": mimetype or "application/octet-stream",
                "data_base64": file_b64,
            }]
            print(f"[gemini] including file: {filename} ({len(file_content)} bytes, mime={mimetype})")

        r = requests.post(GEMINI_ENDPOINT, json=payload, timeout=300)
        print(f"[gemini] POST {GEMINI_ENDPOINT} status={r.status_code}")
        r.raise_for_status()
        data = r.json()
        return data.get("reply") or "No reply."
    except Exception as e:
        print("[gemini] error:", e)
        return f"❌ Error from Gemini server: {e}"

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
    lines = []
    for m in msgs:
        user = m.get("user", "unknown")
        text = (m.get("text") or "").strip()
        if text:
            lines.append(f"<@{user}>: {text}")
    return "\n".join(lines)

@app.event("message")
def on_message(body, client, logger):
    event = body.get("event", {})
    print("[evt] raw:", event)

    subtype = event.get("subtype")
    user    = event.get("user")
    channel = event.get("channel")
    text    = (event.get("text") or "").strip()
    ts      = event.get("ts")
    thread_ts = event.get("thread_ts") or ts
    files   = event.get("files", [])

    if subtype in ['channel_join', 'channel_leave']:
        print(f"[skip] skipping system message with subtype={subtype}")
        return

    if not user:
        print("[skip] no user (probably a bot/system event)")
        return
    if user == BOT_USER_ID:
        print("[skip] our own message")
        return

    if TARGET_CHANNEL and channel != TARGET_CHANNEL:
        print(f"[skip] not target channel (got {channel}, want {TARGET_CHANNEL})")
        return

    has_files = len(files) > 0
    print(f"[ok] replying in thread={thread_ts} channel={channel} user={user} text={text!r} files={len(files)}")

    def work():
        ctx_msgs  = fetch_thread_context(client, channel, thread_ts, limit=6)
        ctx_block = render_ctx(ctx_msgs)

        file_content = None
        filename = None
        mimetype = None

        if has_files:
            file_id = files[0].get("id")
            if file_id:
                print(f"[file] attempting to download file_id={file_id}")
                file_content, filename, mimetype, error = download_file(client, file_id)
                if error:
                    reply = f"❌ Sorry, I couldn't download the file: {error}"
                    try:
                        client.chat_postMessage(channel=channel, text=reply, thread_ts=thread_ts)
                        print("[send] posted file error reply")
                    except Exception as e:
                        print("[send] chat_postMessage failed:", e)
                    return

        if file_content:
            prompt = (
                "You are an assistant participating in a Slack thread.\n"
                "The user has shared a file with their message. Please analyze the file and respond to their request.\n\n"
                "### Message with file\n"
                f"<@{user}>: {text}\n"
                f"File: {filename}\n"
            )
        else:
            prompt = (
                "You are an assistant participating in a Slack thread.\n"
                "Answer the newest message, considering the short context if provided.\n\n"
                "### New message\n"
                f"<@{user}>: {text}\n"
            )

        reply = call_gemini(
            prompt,
            context=ctx_block,
            file_content=file_content,
            filename=filename,
            mimetype=mimetype,
        )

        try:
            client.chat_postMessage(channel=channel, text=reply, thread_ts=thread_ts)
            print("[send] posted reply")
        except Exception as e:
            print("[send] chat_postMessage failed:", e)

    threading.Thread(target=work, daemon=True).start()

# Handle file events - prevents "Unhandled request" warnings
@app.event("file_shared")
def handle_file_shared_events(body, logger):
    event = body.get("event", {})
    print(f"[file_shared] file_id={event.get('file_id')} user_id={event.get('user_id')}")
    logger.info(body)

@app.event("file_public")
def handle_file_public_events(body, logger):
    event = body.get("event", {})
    print(f"[file_public] file_id={event.get('file_id')} user_id={event.get('user_id')}")
    logger.info(body)

@app.event("file_created")
def handle_file_created_events(body, logger):
    ev = body.get("event", {})
    logger.info(f"[file_created] file_id={ev.get('file_id')} user_id={ev.get('user_id')}")
    print(f"[file_created] file_id={ev.get('file_id')} user_id={ev.get('user_id')}")

# Optional: mention echo to test pipeline quickly
@app.event("app_mention")
def on_mention(body, say, logger):
    event = body.get("event", {})
    print("[evt] app_mention:", event)
    say("Hi! I am listening 👋", thread_ts=event.get("thread_ts") or event.get("ts"))

if __name__ == "__main__":
    print("Starting Slack Bolt (Socket Mode)…")
    SocketModeHandler(app, SLACK_APP_TOKEN).start()
