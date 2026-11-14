# Try transcription providers

A page for hearing the providers side by side before Rome commits to one. Press start, say one message, press stop. Each provider with a credential gets the same audio at the same time and streams its text back into its own card, with the delay to its first text and its list price per hour.

| Provider | Model | List price for streaming, per hour |
| --- | --- | --- |
| Soniox | `stt-rt-v6` | $0.12 |
| OpenAI | `gpt-live-transcribe` | $1.02 |
| ElevenLabs | `scribe_v2_realtime` | $0.39 |
| AssemblyAI | `universal-3-6-pro` | $0.45 |

Prices were read from each provider's pricing on 2026-11-14.

## Credentials

The server reads `~/.config/rome/voice.env` (mode 600, `KEY=value` lines) each time listening starts, so a key added there works without a restart. A provider without its key shows "no credential".

```
SONIOX_API_KEY=...
OPENAI_API_KEY=...
ELEVENLABS_API_KEY=...
ASSEMBLYAI_API_KEY=...
```

`VOICE_ENV_FILE` points the server at another file.

## Running it

```bash
environments/voice-input/try/run.sh start   # prints https://devbox.tail28287.ts.net/voice-try
environments/voice-input/try/run.sh stop
```

`start` runs the server as the user service `voice-try` on 127.0.0.1:4790 and mounts it on the tailnet at `/voice-try`. `VOICE_TRY_PORT` changes the port.

## What it does with audio

The browser sends 16 kHz mono PCM to the server in 100 ms pieces. The server passes each piece to every provider's streaming API and keeps nothing: no file, no buffer past the piece in hand, no log of audio. Credentials never reach the browser.

The delay to first text runs from the moment the page first hears a voice (the level crosses a fixed threshold) to the moment that provider's first words arrive in the browser. It includes the trip through the devbox, which is the same for every provider.
