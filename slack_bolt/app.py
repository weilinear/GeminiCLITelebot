#!/usr/bin/env python3
import os, time, threading, requests
from dotenv import load_dotenv
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

load_dotenv()

SLACK_BOT_TOKEN = os.environ["SLACK_BOT_TOKEN"]
SLACK_APP_TOKEN = os.environ["SLACK_APP_TOKEN"]
GEMINI_ENDPOINT = os.getenv("GEMINI_ENDPOINT", "http://127.0.0.1:8765/event")
TARGET_CHANNEL  = os.getenv("TARGET_CHANNEL", "").strip()   # optional
# Removed KEYWORD_GATE to allow all messages
# Removed COOLDOWN_SEC to allow immediate responses

assert SLACK_BOT_TOKEN.startswith("xoxb-")
assert SLACK_APP_TOKEN.startswith("xapp-")

app = App(token=SLACK_BOT_TOKEN)

auth = app.client.auth_test()
BOT_USER_ID = auth.get("user_id", "")
print(f"[boot] BOT_USER_ID={BOT_USER_ID} TARGET_CHANNEL={TARGET_CHANNEL!r}")

def call_gemini(prompt: str, context: str = "") -> str:
    try:
        payload = {"mode": "qa", "text": prompt}
        if context:
            payload["context"] = context
        r = requests.post(GEMINI_ENDPOINT, json=payload, timeout=60)
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

    # Minimal filtering - only skip bot's own messages and system messages
    if subtype:
        print(f"[skip] subtype={subtype}")
        return
    if not user:
        print("[skip] no user (probably a bot/system event)")
        return
    if user == BOT_USER_ID:
        print("[skip] our own message")
        return

    # Optional: only respond in target channel if specified
    if TARGET_CHANNEL and channel != TARGET_CHANNEL:
        print(f"[skip] not target channel (got {channel}, want {TARGET_CHANNEL})")
        return

    # Removed keyword gate check
    # Removed cooldown check

    print(f"[ok] replying in thread={thread_ts} channel={channel} user={user} text={text!r}")

    def work():
        ctx_msgs  = fetch_thread_context(client, channel, thread_ts, limit=6)
        ctx_block = render_ctx(ctx_msgs)
        prompt = (
            "You are an assistant participating in a Slack thread.\n"
            "Answer the newest message, considering the short context if provided.\n\n"
            "### New message\n"
            f"<@{user}>: {text}\n"
        )
        reply = call_gemini(prompt, context=ctx_block)
        try:
            client.chat_postMessage(channel=channel, text=reply, thread_ts=thread_ts)
            print("[send] posted reply")
        except Exception as e:
            print("[send] chat_postMessage failed:", e)

    threading.Thread(target=work, daemon=True).start()

# Optional: still keep mention echo to test pipeline quickly
@app.event("app_mention")
def on_mention(body, say, logger):
    event = body.get("event", {})
    print("[evt] app_mention:", event)
    say("Hi! I am listening 👋", thread_ts=event.get("thread_ts") or event.get("ts"))

if __name__ == "__main__":
    print("Starting Slack Bolt (Socket Mode)…")
    SocketModeHandler(app, SLACK_APP_TOKEN).start()