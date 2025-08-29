# GeminiCLI_Slash_Listen
A /listen feature for Gemini CLI 

## Installation 
Clone the repository:
```bash
git clone https://github.com/automateyournetwork/GeminiCLI_Slash_Listen
```

Copy both the commands and scripts folders into your .gemini folder 

## Usage
```bash
/listen: start - Starts the listener on port 8765
```

## Testing your listener externally
If you NGROK out your local 8765 port, you can test your listener by sending a message to the NGROK URL with the following command:
```bash
curl -X POST https://464a3243325f.ngrok-free.app/event   -H "Content-Type: application/json"   -d '{"source":"test","message":"This is a test message from cURL to Gemini CLI. If you are really Gemini CLI please respond with a message that, yes, you are really Gemini CLI and a pleasant haiku for the tester."}'
```

## MCP Integration
If your Gemini CLI is integrated with MCP servers they are fully accessible via the /listen feature. Meaning Gemini CLI will invoke those MCP servers when a message is received if they will help respond to the message.

## Slack Integration 
In Slack if you have a bot you can add /slash commands, such as /gemini, and then point the URL to your NGROK URL. This will allow you to send messages to Gemini CLI via Slack. The reponse will be globally available to all users in the channel.

## Slack Bolt 
There is a Slack Bolt app in the commands folder that can be used to integrate Gemini CLI with Slack. It listens for messages and sends them to Gemini CLI, then returns the response back to Slack.

### Cool things with Slack 
* Send pcaps, imags, pdfs, text, and other files as attachments to your messasge and Gemini CLI will process them.

* Record audio and click send - Gemini CLI will transcribe the audio with Whisper and respond with a text message.


```bash
SLACK_BOT_TOKEN=xoxb-***
SLACK_APP_TOKEN=xapp-***
GEMINI_ENDPOINT=https://<your-ngrok>.ngrok-free.app/event
TARGET_CHANNEL=            # (optional) channel ID
```
You can set these environment variables in your terminal or in a .env file.


## Notes
John Capobianco wrote this feature because he belives Gemini CLI, MCP, A2A, are not just the future but very much the present of automation with artificial intelligence. He is a strong advocate for the use of Gemini CLI and MCP servers in network automation. Ideally we can now tie things like Slack, Teams, and other messaging platforms into Gemini CLI and MCP servers to automate responses to messages and events. Gemini can actually participate in conversations and respond to messages in a way that is helpful and informative.