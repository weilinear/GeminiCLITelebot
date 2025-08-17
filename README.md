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

```bash
/listen: status - Checks the status of the listener
```

```bash
/listen: stop - Stops the listener
```

```bash
/listen: logs - Shows the logs of the listener
```

## Testing your listener 
If you NGROK out your local 8765 port, you can test your listener by sending a message to the NGROK URL with the following command:
```bash
curl -X POST https://b470a7a88fc5.ngrok-free.app/event   -H "Content-Type: application/json"   -d '{"source":"test","message":"This is a test message from cURL to Gemini CLI. If you are really Gemini CLI please respond with a message that, yes, you are really Gemini CLI and a pleasant haiku for the tester."}'
```

## MCP Integration
If your Gemini CLI is integrated with MCP servers they are fully accessible via the /listen feature. Meaning Gemini CLI will invoke those MCP servers when a message is received if they will help respond to the message.

## Slack Integration 
In Slack if you have a bot you can add /slash commands, such as /gemini, and then point the URL to your NGROK URL. This will allow you to send messages to Gemini CLI via Slack. The reponse will be globally available to all users in the channel.

## Notes
John Capobianco wrote this feature because he belives Gemini CLI, MCP, A2A, are not just the future but very much the present of automation with artificial intelligence. He is a strong advocate for the use of Gemini CLI and MCP servers in network automation. Ideally we can now tie things like Slack, Teams, and other messaging platforms into Gemini CLI and MCP servers to automate responses to messages and events. Gemini can actually participate in conversations and respond to messages in a way that is helpful and informative.