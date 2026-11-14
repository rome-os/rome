# Try transcription providers

A page for hearing the providers side by side before Rome commits to one. Press start, say one message, press stop. Each provider with a credential gets the same audio at the same time and streams its text back into its own card, with the delay to its first text and its list price per hour.

| Provider | Model | Vendor's list price for streaming, per hour |
| --- | --- | --- |
| Soniox | `stt-rt-v6` | [$0.12](https://soniox.com/pricing) |
| OpenAI | `gpt-live-transcribe` | [$1.02](https://developers.openai.com/api/docs/models/gpt-live-transcribe) ($0.017 per minute) |
| ElevenLabs | `scribe_v2_realtime` | [$0.22](https://elevenlabs.io/pricing/api) (base tier) |
| AssemblyAI | `universal-3-6-pro` | [$0.45](https://www.assemblyai.com/pricing) (billed while connected, not per second of audio) |

Each price was read from the vendor's own page on 2026-11-14.

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
environments/voice-input/try/public.sh up         # https://voice-try.romeos.dev and https://voice-input.romeos.dev
environments/voice-input/try/public.sh password   # the guardian's password for voice-input.romeos.dev
environments/voice-input/try/public.sh down
```

Both hostnames go through the devbox's Cloudflare Tunnel and sit behind its Cloudflare Access app for `*.romeos.dev`, so only the allowed identity reaches them. `up` runs three containers: the try page, a Rome of its own built from the environment's image and transcribing with real Soniox, and an edge Caddy that Traefik routes `voice-try.rome.localhost` and `voice-input.rome.localhost` to. That Rome is separate from the environment's, so trying voice input never disturbs a verifier run, and `env.sh reset` never wipes it. Its guardian is `guardian`, with a password `up` generates once and keeps in `~/.rome-environments/voice-input/public/` (mode 600).

The server also runs on its own: `node environments/voice-input/try/server.mjs [--port 4790] [--host 127.0.0.1]`.

## What it does with audio

The browser sends 16 kHz mono PCM to the server in 100 ms pieces. The server passes each piece to every provider's streaming API and keeps nothing: no file, no buffer past the piece in hand, no log of audio. Credentials never reach the browser.

The delay to first text runs from the moment the page first hears a voice (the level crosses a fixed threshold) to the moment that provider's first words arrive in the browser. It includes the trip through the devbox, which is the same for every provider.
