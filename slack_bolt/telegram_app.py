
import os
import logging
import threading
import requests
import base64
import telebot
from dotenv import load_dotenv

load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.DEBUG if os.getenv("DEBUG", "0") == "1" else logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
GEMINI_ENDPOINT = os.getenv("GEMINI_ENDPOINT", "http://127.0.0.1:8765/event")
if "https" in GEMINI_ENDPOINT:
    GEMINI_ENDPOINT = GEMINI_ENDPOINT.replace("https://", "http://")
TARGET_CHAT_ID = os.getenv("TARGET_CHAT_ID", "").strip()
DEBUG = os.getenv("DEBUG", "0") == "1"


bot = telebot.TeleBot(TELEGRAM_BOT_TOKEN)

logging.info(f"[boot] TELEGRAM_BOT_TOKEN loaded. TARGET_CHAT_ID={TARGET_CHAT_ID!r}")

def download_file(file_id):
    try:
        file_info = bot.get_file(file_id)
        file_path = file_info.file_path
        filename = os.path.basename(file_path)
        
        file_url = f"https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}"
        
        resp = requests.get(file_url, timeout=30)
        resp.raise_for_status()
        
        # Get mimetype from response headers
        mimetype = resp.headers.get('content-type', 'application/octet-stream')
        
        logging.info(f"[file] downloaded {filename} ({len(resp.content)} bytes, mime={mimetype})")
        return resp.content, filename, mimetype, None
    except Exception as e:
        logging.error(f"[file] download error: {e}")
        return None, None, None, str(e)

def call_gemini(prompt: str, context: str = "", file_content=None, filename=None, mimetype=None, timeout_ms=30000):
    try:
        payload = {
            "mode": "qa",
            "text": prompt,
            "context": context or "",
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
        logging.info(f"[gemini] POST {GEMINI_ENDPOINT} status={r.status_code}")
        r.raise_for_status()
        return r.json()
    except Exception as e:
        logging.error(f"[gemini] error: {e}")
        return {"ok": False, "error": str(e)}

def get_thread_context(chat_id, message_id, limit=10):
    # Telegram doesn't have threads like Slack, so we'll fetch recent messages from the chat.
    # This is a placeholder for more sophisticated context gathering if needed.
    return ""

@bot.message_handler(func=lambda message: True, content_types=['text', 'document', 'photo'])
def on_message(message):
    if DEBUG:
        logging.debug(f"received message: {message.__dict__}")

    chat_id = str(message.chat.id)
    if TARGET_CHAT_ID and chat_id != TARGET_CHAT_ID:
        return

    def work():
        user = message.from_user
        text = message.text or message.caption or ""
        
        file_content, filename, mimetype = None, None, None
        file_id = None

        if message.document:
            file_id = message.document.file_id
        elif message.photo:
            file_id = message.photo[-1].file_id

        if file_id:
            file_content, filename, mimetype, error = download_file(file_id)
            if error:
                bot.reply_to(message, f"❌ File error: {error}")
                return

        prompt = f"You are an assistant in Telegram.\n<{user.username}>: {text}\n"
        if filename:
            prompt += f"File: {filename}\n"

        context = get_thread_context(chat_id, message.message_id)
        
        result = call_gemini(prompt, context=context, file_content=file_content,
                             filename=filename, mimetype=mimetype)

        if DEBUG:
            logging.debug(f"gemini response: {result}")

        try:
            if isinstance(result, dict) and result.get("ok") and result.get("reply"):
                payload = result["reply"]
                if isinstance(payload, dict):
                    reply_text = (payload.get("text") or "").strip()
                else:
                    reply_text = str(payload).strip()

                if not reply_text:
                    reply_text = "(no text)"
                bot.reply_to(message, reply_text)
                logging.info("[send] posted text reply")
            else:
                err = result.get("error") if isinstance(result, dict) else "Unknown error"
                notice = f"❌ {err}" if err else "Working…"
                if file_content and not err:
                    notice = "📎 Got your file—processing… I’ll reply here when it’s ready."
                bot.reply_to(message, notice)
                logging.info("[send] posted placeholder/notice")
        except Exception as e:
            logging.error(f"[send] reply failed: {e}")

    threading.Thread(target=work, daemon=True).start()

def start_telegram_bot():
    logging.info("Starting Telegram bot…")
    bot.polling()

if __name__ == "__main__":
    start_telegram_bot()
