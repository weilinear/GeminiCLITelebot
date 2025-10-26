import os
import subprocess
import json
import telebot
from telebot.types import Message

# --- Configuration ---
# Get your Telegram Bot Token from an environment variable
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
if not BOT_TOKEN:
    raise ValueError("Please set the TELEGRAM_BOT_TOKEN environment variable.")

# A list of allowed directories for the /cd command
ALLOWED_DIRECTORIES = [
    os.path.abspath(p) for p in os.environ.get("ALLOWED_DIRECTORIES", "./").split(',')
]

bot = telebot.TeleBot(BOT_TOKEN)

# --- Bot Handlers ---

@bot.message_handler(commands=['start', 'hello'])
def send_welcome(message: Message):
    """
    Handles the /start and /hello commands with a welcome message.
    """
    bot.reply_to(message, "Hi there! I'm a bot that can chat with Gemini.\n\n"
                          "To start a chat, just send me your prompt.\n\n"
                          "For example:\nWhat is the capital of Washington State?")

@bot.message_handler(commands=['cd'])
def handle_cd(message: Message):
    """
    Handles the /cd command to change the current working directory.
    """
    try:
        # Extract the directory path from the message
        relative_path = message.text.split(maxsplit=1)[1]
        
        # Get the absolute path of the requested directory
        target_path = os.path.abspath(os.path.join(os.getcwd(), relative_path))
        
        # --- Security Check ---
        # Check if the target path is within any of the allowed directories
        if not any(os.path.commonpath([allowed_dir, target_path]) == allowed_dir for allowed_dir in ALLOWED_DIRECTORIES):
            bot.reply_to(message, f"Error: Access to '{relative_path}' is restricted.")
            return
            
        # Change the current working directory
        os.chdir(target_path)
        
        # Get the new current working directory
        new_cwd = os.getcwd()
        
        # Reply with the new current working directory
        bot.reply_to(message, f"Changed current working directory to: {new_cwd}")
    except IndexError:
        # Handle case where no directory is provided
        bot.reply_to(message, "Please provide a directory path after the /cd command.")
    except FileNotFoundError:
        # Handle case where the directory does not exist
        bot.reply_to(message, f"Error: Directory not found at '{relative_path}'")
    except Exception as e:
        # Handle other potential errors
        bot.reply_to(message, f"An error occurred: {e}")

@bot.message_handler(func=lambda message: True)
def handle_message(message: Message):
    """
    Handles all text messages to stream a response from Gemini CLI.
    """
    prompt = message.text
    chat_id = message.chat.id

    # Send an initial message to be updated with the streamed response
    sent_message = bot.send_message(chat_id, "Generating response...")
    message_id = sent_message.message_id

    try:
        # Command to run Gemini CLI in headless streaming mode
        command = ['gemini', '--output-format', 'stream-json', '--prompt', prompt, '--yolo']

        # Start the subprocess
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        full_response = ""
        last_sent_response = ""

        # Read the output line by line
        for line in iter(process.stdout.readline, ''):
            if not line:
                break
            try:
                # Each line is a JSON event
                event = json.loads(line)

                # We are interested in 'message' events from the 'assistant'
                if event.get('type') == 'message' and event.get('role') == 'assistant':
                    content = event.get('content', '')
                    if content:
                         # The 'delta': true indicates a streaming update in some versions
                        if event.get('delta'):
                            full_response += content
                        else: # This handles the full message content if delta is not present
                            full_response = content

                        # To avoid hitting Telegram API limits, we edit the message only when
                        # the content has changed.
                        if full_response != last_sent_response:
                            # Edit the message with the updated full response
                            bot.edit_message_text(full_response, chat_id, message_id)
                            last_sent_response = full_response

            except json.JSONDecodeError:
                # Ignore lines that are not valid JSON
                print(f"Warning: Could not decode JSON from line: {line.strip()}")
            except Exception as e:
                # Handle other exceptions, like Telegram API errors
                if "message is not modified" not in str(e):
                     print(f"An error occurred: {e}")


        process.stdout.close()
        # Wait for the process to terminate and get the exit code
        return_code = process.wait()

        if return_code != 0:
            # If there was an error, get the error message from stderr
            error_output = process.stderr.read()
            print(f"Gemini CLI Error:\n{error_output}")
            bot.edit_message_text(f"An error occurred while running Gemini CLI:\n\n`{error_output}`",
                                  chat_id, message_id, parse_mode="Markdown")
        elif not full_response:
             bot.edit_message_text("I received an empty response. Please try a different prompt.",
                                  chat_id, message_id)


    except FileNotFoundError:
        print("Error: 'gemini' command not found.")
        bot.edit_message_text("Error: The 'gemini' command-line tool is not installed or not in the system's PATH.",
                              chat_id, message_id)
    except Exception as e:
        print(f"A critical error occurred: {e}")
        bot.edit_message_text(f"A critical error occurred: {e}", chat_id, message_id)


# --- Main Execution ---

if __name__ == "__main__":
    print("Bot is starting...")
    bot.infinity_polling()