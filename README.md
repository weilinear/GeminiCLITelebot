# Gemini-Cli Telegram Bot

This is built using Telegram (telebot, pytelegrambotapi) to run Gemini Cli in streaming and Yolo mode. Currently it needs Gemini Cli Nightly to run properly.

## Start

### Docker

Since it runs in Yolo mode, it might be much safer to use this in a docker container. To build and run the Docker image, follow these steps:

1.  Create a `.env` file in the root directory of the project, similar to `.env.sample`, and fill in your environment variables.
2.  Build the Docker image:
    ```bash
    docker build -t gemini-cli-telebot .
    ```
3.  Run the Docker container:
    ```bash
    docker run -d --name gemini-cli-telebot --env-file ./.env gemini-cli-telebot
    ```

### Debug/Local Run
#### Check Gemini Cli Version
It needs gemini cli to support streaming mode (`--output-format stream-json`).
```bash
$ gemini --output-format stream-json --prompt "What is 2+2?"

{"type":"init","timestamp":"2025-10-26T05:10:57.220Z","session_id":"a74f95b6-8130-432a-9cba-9702fd26a429","model":"auto"}
{"type":"message","timestamp":"2025-10-26T05:10:57.220Z","role":"user","content":"What is 2+2?"}
{"type":"message","timestamp":"2025-10-26T05:10:59.577Z","role":"assistant","content":"2+2 is 4.","delta":true}
{"type":"result","timestamp":"2025-10-26T05:10:59.923Z","status":"success","stats":{"total_tokens":8108,"input_tokens":7988,"output_tokens":56,"duration_ms":2703,"tool_calls":0}}

$ gemini --version

0.12.0-nightly.20251023.c4c0c0d1
```

#### Start the server
```bash
python -m src.telegcli.app
```

# Reference
This has been inspired by https://github.com/automateyournetwork/GeminiCLI_Slash_Listen. 