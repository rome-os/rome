# Voice input environment

Everything the voice input verifier needs to score the product without a person: a Rome instance it can start and reset, signed in to a Rome Cloud of its own, a Chrome whose microphone is a recording, and a transcriber it controls. The rules it serves are in `~/.rome-environments/voice-input/rules-V5.md`. The verifier lives in `verifier/` and drives the environment only through `voice-env`.

The `try/` folder is separate: a page for hearing the transcription providers side by side. See [try/README.md](try/README.md).

## Lifecycle

```bash
environments/voice-input/env.sh up [--no-build]   # build and start, or bring up to date
environments/voice-input/env.sh reset             # a fresh instance with only its guardian, and an empty Rome Cloud
environments/voice-input/env.sh down              # remove everything up created
```

`up` merges the product ref with this branch in a throwaway checkout and builds the production Rome image there, so product code never lands on `voice-input`. `VOICE_PRODUCT_REF` picks the product (default `origin/main`); a product branch is the usual choice, such as `VOICE_PRODUCT_REF=origin/<branch> env.sh up`. `--no-build` reuses the last image.

`up` also checks out Rome Cloud at `VOICE_CLOUD_REF` (default `origin/main`) from `~/workspace/rome-cloud` into `~/.rome-environments/voice-input/rome-cloud`, installs it and migrates its own database.

`up` creates these containers on the network `rome-env-voice-input`:

| Container | What it is | Reached at |
| --- | --- | --- |
| `rome-env-voice-input-rome` | Rome, with the dashboard behind its own Caddy, as in production | `http://127.0.0.1:4780` |
| `rome-env-voice-input-signer` | Rome's signer, as in `docker-compose.yml`: no network, holds the instance's key, shares only its socket with Rome | |
| `rome-env-voice-input-cloud` | Rome Cloud's `packages/pantheon` dev server, with its transcription provider set to the stand-in | Rome: `http://cloud:3100` |
| `rome-env-voice-input-cloud-pg` | Rome Cloud's Postgres | |
| `rome-env-voice-input-transcriber` | The stand-in transcriber | Rome: `ws://transcriber:8790/transcribe-websocket`; control: `http://127.0.0.1:4781` |
| `rome-env-voice-input-provider-route` | The route from Rome to real Soniox, which `transcriber route cut` breaks | Rome: `stt-rt.soniox.com:443`, passed through to Soniox; control: `http://127.0.0.1:4785` |
| `rome-env-voice-input-capture` | tcpdump in Rome's network namespace, only while a capture runs | |

State, including the guardian's password and session cookie, is in `~/.rome-environments/voice-input/run/` (mode 600). One checkout owns the environment at a time; `ROME_ENV_TAKE_OVER=1` moves it.

## Secrets

`~/.config/rome/voice.env`, mode 600, `KEY=value` lines. Each is optional:

- `SONIOX_API_KEY`: needed only for `voice-env transcriber real`. Only the local Rome Cloud holds it; it never goes into Rome's config.
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`: a model login, so the agent answers sent messages. Every model tier then runs on `claude-haiku-5-5` (`VOICE_MODEL` overrides). Without one, a sent message is stored with the guardian as sender, and the agent's answer is an error.

## voice-env

Every command prints JSON on stdout. Errors go to stderr with a non-zero exit.

| Command | What it does |
| --- | --- |
| `version` | The product ref and commit, the environment's and the verifier's commits, Rome Cloud's ref and commit (`cloud`), how Rome signs in (`signIn`: `cloud` or `own`), the forced gate (`gate`), the transcriber the environment set up (`soniox` or `stand-in` with its script), `transcriberInUse` (Rome Cloud's answer to `GET /v1/transcription/provider`: the provider, host and model a session gets now; null when Rome is signed out), the model, the dashboard address |
| `browser --mic <wav> [--permission unset\|granted\|refused] [--lang en\|zh-CN]` | Starts Chrome and prints `cdp`, the address to connect to: `chromium.connectOverCDP(cdp)`, then use `contexts()[0].pages()[0]`, already on the dashboard and signed in as the guardian. A new `browser` replaces the last one. |
| `browser stop` | Stops Chrome and the proxy |
| `transcriber stand-in [--text <t>] [--first-ms <n>] [--token-ms <n>]` | The stand-in answers each session with that text, the first token `first-ms` after the first audio and one token every `token-ms` after that |
| `transcriber stand-in --error <code> [--after-ms <n>] [--type <error_type>]` | The stand-in answers each session with a Soniox error message `after-ms` after the first audio, then closes |
| `transcriber real` | Real Soniox: restarts Rome Cloud with `SONIOX_API_KEY` and Soniox's addresses. Rome is untouched. |
| `transcriber session-cap <seconds>` / `session-cap off` | Every session on a temporary key ends that many seconds after it starts with Soniox's `temp_api_key_session_expired`, sooner than the key's own `max_session_duration_seconds`, so the time-limit stop can be tried without waiting 30 minutes. `off` leaves only the key's own cap. Stand-in only; a restart of the stand-in turns it off. |
| `transcriber status` | The mode, the stand-in's script, and each session it has served: the start request (key removed), how the key was sent, audio bytes received, how it ended |
| `transcriber route cut` / `route restore` / `route status` | `cut` resets every open connection from Rome to real Soniox and refuses new ones until `restore`, as a route that drops in the middle of a message. It needs `transcriber real`; on the stand-in, use `--error`. `status` prints `{cut, open, connections: [{opened, closed, closedBy, bytesUp, bytesDown}]}`, where `closedBy` is `rome`, `provider` or `cut`. |
| `cloud status` | `{"signedIn", "decoySettings"}`. `signedIn`: Rome points at the environment's Rome Cloud, and its signer key is registered there on an active instance. `decoySettings`: Rome's config holds the removed `ROME_TRANSCRIPTION_*` settings with the decoy key, which only `cloud sign-out` writes. |
| `cloud usage` | `{"events": [{"eventId", "sessionId", "provider", "model", "seconds", "at"}]}`: the voice usage events Rome Cloud stored for this instance, oldest first. `eventId` is the id Rome sent with the event. `sessionId` is the listening session's id, the `sessionId` that `cloud session` returns, or null when Rome Cloud recorded none. `seconds` is the audio's length. |
| `cloud session` | `{"status", "body"}`: Rome Cloud's answer to `POST /v1/transcription/sessions`, asked as Rome asks it (from Rome's container, with a token from Rome's signer). A minted key in the body is replaced by `(removed)`. |
| `cloud provider` | `{"status", "body"}`: Rome Cloud's answer to `GET /v1/transcription/provider`, asked the same way |
| `cloud minted` | `{"count"}`: the temporary keys the stand-in has minted since it started or was reset |
| `gate on` / `gate off` | Forces Rome Cloud's `voice_input` gate for every account (`FEATURE_GATE_VOICE_INPUT`) and restarts Rome Cloud. `on` after `up` and `reset`. |
| `cloud sign-in` / `cloud sign-out` | Restarts Rome on the same data, signed in to Rome Cloud (the default after `up` and `reset`) or not signed in (see below). Prints `cloud status`. |
| `logs [--since <time>] [--match <text>]` | `{"lines": [...]}`: Rome's container log since a time (`docker logs --since`, such as `2026-11-14T11:00:00Z` or `10m`), only the lines containing `match`. Rome logs JSON, so each line is its parsed entry; a line that is not JSON comes as `{"text"}`. |
| `network cut` / `network restore` | Drops every open connection of the browser and refuses new ones, or lets them through again |
| `chats` | The dashboard's chats, from `GET /api/chat/sessions` |
| `messages --chat <id>` | The chat's stored messages: role, sender, text, attachments, `inputState`, time |
| `audio-scan` | Searches the instance for audio and lists each finding with its reason |
| `capture start` / `capture stop` | Records the browser's and the server's outbound requests; `stop` prints the record and lists in `audio` each request that carried audio and where it went |

### The route to real Soniox

On the environment's network, Soniox's streaming host `stt-rt.soniox.com` answers at the route container, so Rome dials it by the same name and port as in production. The route passes every byte through to Soniox's addresses, resolved on the devbox when the environment starts, and reads none of them: TLS runs between Rome and Soniox, and Rome checks Soniox's own certificate. Rome's DNS answer for the host is the route's address, so the capture names that connection `stt-rt.soniox.com`. Only Rome's connections to the streaming host go through the route; Rome Cloud mints keys at `api.soniox.com` directly.

### The stand-in transcriber

It speaks Soniox's real-time protocol: the start request with `model` and `audio_format`, binary audio frames, an empty text frame to finish, `keepalive` and `finalize` control messages, token responses with `is_final`, the `finished` response, and error responses with `error_code` and `error_type`. It accepts the key as `Authorization: Bearer`, in the start request's `api_key`, or as a WebSocket protocol, and refuses any other key with Soniox's 401.

Like Soniox, it mints temporary keys at `POST /v1/auth/temporary-api-key` (Bearer the long-lived key `stand-in-key`; `usage_type`, `expires_in_seconds`, `client_reference_id`, `single_use`, `max_session_duration_seconds`; answers `api_key` and `expires_at`). A single-use key opens one session, and a second session on it gets 401. A session on a key with `max_session_duration_seconds` ends with error `temp_api_key_session_expired` when that time is up. The stand-in sends it with code 408. The error type is the one Rome Cloud's provider documents and the product handles; the code is the environment's guess. Only the local Rome Cloud holds `stand-in-key`, and it mints one temporary key per listening session. The stand-in accepts only the temporary keys it minted and still valid, never `stand-in-key` itself, so a session that reaches it proves the key came through Rome Cloud. `transcriber status` lists each mint (its `client_reference_id`) and each session's `keyKind`. It also lists `decoyConnections`: every connection that presented the decoy key from the section below, which should always be empty.

### An instance that is not signed in

`voice-env cloud sign-out` restarts Rome on the same data with `PANTHEON_BASE_ORIGIN` empty, so Rome is not signed in to Rome Cloud and has no voice input. `voice-env cloud sign-in` signs it back in.

Signed out, Rome's config also gets `ROME_TRANSCRIPTION_PROVIDER`, `ROME_TRANSCRIPTION_URL` (the stand-in) and `ROME_TRANSCRIPTION_API_KEY`. The product removed those settings in rules V5. They are set only so rule 11 can show the product ignores them: the dashboard shows no voice control, and no connection reaches the stand-in. The key is the decoy `decoy-not-a-credential`, never a real credential, and the stand-in refuses it and records any connection that presents it in `decoyConnections`.

Tokens come the way Soniox sends them: English as words with their leading space, Chinese as single characters. The two newest tokens stay non-final until the next ones arrive. On the empty frame every remaining token goes out final, then `finished`. The stand-in does not listen to the audio; it counts the bytes and drops them.

### How capture decides a request carried audio

The same rules on both sides, in `lib/audio.mjs`:

- An audio content type, or a body that starts with an audio file's signature (WAV, Ogg, WebM, FLAC, MP3, MP4/M4A, AAC), or base64 of one inside JSON.
- A WebSocket the environment can read (plain `ws://`, such as the dashboard's own): 4096 bytes or more of binary frames from the client, or base64 audio in a text frame.
- An encrypted connection: an upload of at least 4096 bytes in each of 3 or more different seconds within 10 seconds, on one connection. A single burst, such as a model request, does not count, nor do small uploads spread over minutes, such as Chrome's update checks. This is a judgment from sizes and timing; each record says which rule decided it.
- Rome's connection to the stand-in: the stand-in's own count of audio bytes received on that connection, matched by Rome's port. The capture lists Rome's outbound traffic one connection at a time, so each listening session is its own record.

Browser side: Chrome sends every request through the environment's proxy, loopback included. Server side: tcpdump in Rome's network namespace records packet sizes only, never payload. A connection counts as Rome's outbound when it leaves from an ephemeral port of Rome's container; hosts come from Rome's own DNS answers, and the environment names the stand-in `transcriber` and Rome Cloud `cloud` itself, by the host names Rome dials them at.

#### Chrome's update checks are not audio

A run on 2026-11-14 (08:20) counted Rome's uploads to `update.googleapis.com` as audio: 39,297 bytes, "sustained upload over 3 seconds". That was the capture's mistake, and the uploads were not audio:

- **What the capture matched on.** The connection is encrypted, so the capture saw packet sizes and times only, never content. It then added up every connection to that host across the whole 24-minute run, and found 4096 bytes or more in 3 different seconds, minutes apart. Each of those seconds was a separate update check.
- **Why it no longer matches.** Each connection is now judged on its own, and the 3 busy seconds must fall within 10 seconds. Every update connection was a single burst under 15 KB, lasting less than a second.
- **Where the uploads came from.** Rome's own Google Chrome made them, the browser its agents use. From inside Rome's process and network namespaces, `ss -tnp` showed Google's addresses held by its `chrome` network service. Rome's voice code is not involved.
- **Where the audio went.** In the same run, all the audio the browser sent Rome is accounted for at the stand-in, session by session, with matching byte counts.

Blocking the update hosts only stops the environment's Chrome from checking for updates. A production Rome's Chrome keeps checking. That is fine for rule 10, because the checks carry no audio, as above.

### audio-scan

Searches `/home/rome` (the profile folder, which holds the database `rome.db` and its WAL), `/home/user`, `/app/memory`, `/tmp`, `/var/log`, s6's service logs and the container's logs. A file is a finding when it has an audio extension, starts with an audio signature, or holds a signature or base64 audio anywhere inside. Raw PCM has no signature, so a raw PCM dump without an audio extension would not be found.

## Differences from production

- A recording stands in for the microphone (Chromium's fake capture device, played once, not looped).
- A dev instance on the devbox stands in for the guardian's Rome, and a Rome Cloud dev server (`next dev`, compiled on first request; `up` warms the routes Rome calls) on the same network stands in for Rome Cloud, at `http://cloud:3100` instead of `https://romeos.cc`.
- Rome is signed in to Rome Cloud without the browser consent a guardian goes through: the environment writes an account and an instance token straight into Rome Cloud's database, the way Rome Cloud's admin dev tokens are made, and gives Rome the token in `ROME_INSTANCE_TOKEN`, the way a provisioned instance gets it. Rome then registers its signer key with it as in production.
- Rome has no slug, so Rome Cloud sign-in for the guardian stays off and the guardian signs in with a local password the environment created. In production most guardians sign in through Rome Cloud.
- Signed out (`cloud sign-out`), Rome Cloud is switched off for Rome (`PANTHEON_BASE_ORIGIN` empty), and its config holds the decoy `ROME_TRANSCRIPTION_*` settings described above.
- The dashboard is reached over plain HTTP on `127.0.0.1`, which Chrome treats as a secure context, instead of HTTPS on the guardian's own address.
- Chrome is headless Chromium from Nix, with a fresh profile per launch. The microphone permission is written into that profile before launch, as if the guardian had answered Chrome's prompt on an earlier visit. With `unset`, the headless browser has no one to answer the prompt, so a request for the microphone fails with `NotAllowedError` once the prompt would show.
- Chrome's own background traffic to Google (updates, sync and similar) is switched off where flags allow, so it stays out of captures. Some still shows, such as `mtalk.google.com`.
- The browser's traffic goes through a proxy on the devbox; a guardian's goes straight out.
- The transcriber is a stand-in unless `transcriber real` is set. The stand-in returns scripted text, not what the recording says, and its temporary keys are its own random strings, not Soniox's.
- Without a model login, the agent cannot answer, so a sent message is stored with `inputState` `failed` and an error from the agent follows it. With a login, every tier runs on Haiku.
- Rome's own server-side Chrome runs as in production and makes its own requests to Google, which show in server captures. Its component updater is the exception: Rome's container resolves `update.googleapis.com`, `edgedl.me.gvt1.com`, `redirector.gvt1.com` and `dl.google.com` to nowhere, because its update checks are uploads a capture could mistake for audio. Chrome's `ComponentUpdatesEnabled` policy did not stop them.
- Rome Cloud's voice input gate is forced through its environment for every account, not set per account in Statsig.
