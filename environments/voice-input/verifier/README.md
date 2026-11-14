# Voice input verifier

The verifier scores voice input against rule set V2 (`~/.rome-environments/voice-input/rules-V2.md`), pass or fail per rule. It sees the product only as a guardian does, through Chrome and the contract in the rules. It drives the environment only through the `voice-env` command that `environments/voice-input/` provides.

## Run it

1. Build the script once. It downloads set A's recordings, synthesizes set B, and writes both to `~/.rome-environments/voice-input/script/`. Set B needs piper-tts 1.8 or newer with its Mandarin extras, because the nixpkgs piper lacks the pinyin the Mandarin voice uses. Install it in a venv and name it with `PIPER`. On NixOS its wheels also need `PIPER_LIBS`, a library path holding `libstdc++` and `libz`.

   ```bash
   python3 -m venv ~/.cache/piperenv
   ~/.cache/piperenv/bin/pip install "piper-tts[zh]==1.8.0" sentence-stream
   export PIPER=~/.cache/piperenv/bin/piper
   export PIPER_LIBS="$(nix eval --raw nixpkgs#stdenv.cc.cc.lib)/lib:$(nix eval --raw nixpkgs#zlib)/lib"
   nix-shell environments/voice-input/verifier/script/shell.nix \
     --run "python3 -I environments/voice-input/verifier/script/build.py"
   ```

2. Score the product, inside `nix develop`.

   ```bash
   node environments/voice-input/verifier/verify.mjs --phase 1
   node environments/voice-input/verifier/verify.mjs --rules 2,3
   ```

| Option | Meaning | Default |
| --- | --- | --- |
| `--phase <n>` | Every rule of phase `n` and of the phases before it | 1 |
| `--rules <list>` | Only these rules, comma separated. A rule with no scenario yet is reported as not checked | |
| `--place <name>` | Where to score. Only `chrome` exists in phase 1 | `chrome` |
| `--transcriber <mode>` | `real` or `stand-in` scores the product with that transcriber behind Rome. On `stand-in`, rules 2 and 3 are not checked, because the stand-in's text and timing are scripted. A provider name runs the comparison below instead | `real` |
| `--dirty` | Run even though the code under test has uncommitted changes. The report says so | off |
| `--voice-env "<command>"` | The `voice-env` command | `environments/voice-input/voice-env` |
| `--reset "<command>"` | The command that empties the instance before a run | `environments/voice-input/env.sh reset` |
| `--script <dir>` | Where the built script is | `~/.rome-environments/voice-input/script` |
| `--after-speech <s>` | How long listening goes on past the last word before the stop action | 4 |
| `--send-check <s>` | How long after listening stops rule 5 waits for a message nobody sent | 60 |
| `--send-wait <s>` | How long to wait for a message after the send action | 10 |
| `--steady <s>` | How long the field must stay unchanged before it is read | 1.5 |
| `--out <dir>` | Write the report here instead of the runs folder | |

It exits 0 when no rule fails, 1 when a rule fails, and 2 when it could not run. A phase 1 run takes about 35 minutes, most of it rule 5's 60-second wait after each of set B's 20 messages.

## The report

Each run writes `report.json` and `report.md` to `~/.rome-environments/voice-input/runs/<time>-<product commit>/`. The top states the commits of the product, the environment and the verifier, the transcriber in use (from `voice-env version`), the transcriber mode asked for, the rules version, the place, the waits and the time. Then each rule is pass, fail or not checked, with the reason and its evidence: script message keys and stored message ids. The verifier refuses to run when anything under test has uncommitted changes, unless `--dirty` is passed.

## The script

`script/selection.json` names the messages and their written text, and `script/build.py` turns them into WAV files and `manifest.json`. A copy of the manifest is kept in `script/manifest.json`, so the times and the text are reviewable.

The script has two sets of 20 messages, 8 English, 8 Mandarin and 4 Mandarin mixed with English, each tagged with its `set` in the manifest.

- **Set A** is real speech from public datasets. Only rule 3 uses it.
- **Set B** is synthesized speech, marked `synthesized` in its sources, of messages worded like those a guardian sends an assistant. Rules 2, 3, 5, 6 and 10 use it.

| Messages | Source | Licence |
| --- | --- | --- |
| `en-1` to `en-8` | [FLEURS](https://huggingface.co/datasets/google/fleurs), `en_us`, test split. 4 female and 4 male speakers | CC BY 4.0 |
| `zh-1` to `zh-8` | FLEURS, `cmn_hans_cn`, test split. 4 female and 4 male speakers | CC BY 4.0 |
| `mixed-1` to `mixed-4` | [ASCEND](https://huggingface.co/datasets/CAiRE/ASCEND), test split, Mandarin with English terms in conversation. 2 speakers | CC BY-SA 4.0 |
| `b-en-1` to `b-en-8` | Synthesized with [Piper](https://github.com/OHF-Voice/piper1-gpl) voices `en_US-kristin-medium`, `en_US-bryce-medium` and `en_US-joe-medium` | Voices public domain or CC0 |
| `b-zh-1` to `b-zh-8` | Synthesized with Piper voice `zh_CN-chaowen-medium` | Voice CC0 |
| `b-mixed-1` to `b-mixed-4` | Mandarin runs in `zh_CN-chaowen-medium`, English runs in `en_US-kristin-medium`, joined | Voices CC0 and public domain |
| `long-1` | 20 consecutive FLEURS Mandarin test recordings joined with 0.4 s gaps, with two 5-second pauses, 179 s in all | CC BY 4.0 |

FLEURS sentences come from Wikipedia, so they read less like messages to an assistant than the brief asks. The selection takes the plainest ones: travel advice, places, things to do with children. The ASCEND messages are conversational, with the speakers' fillers and repeats in the written text. Set B covers the wording set A lacks. Its mixed messages join two voices because the Mandarin voice drops Latin words, so the switch between languages is audible.

Each WAV is 48 kHz mono 16-bit PCM, with 1 s of silence before the speech and 6 s after it. `firstWordAt` and `lastWordAt` in the manifest are seconds from the start of the file, measured on the audio's energy. The long message is Mandarin because Mandarin is the harder language in the script.

## Rules checked

| Rule | What the scenario does | Pass bar |
| --- | --- | --- |
| 2 Text appears as you speak | Plays each of set B's 20 messages as the microphone in a new Chrome, starts listening, stops it `--after-speech` seconds past the last word, and records the field's text every 25 ms | At least 18 of 20 messages show text within 2 s of the first word and reach their final text within 2 s of the last word. Times count from the start click |
| 3 The text is what you said | Compares each field's text with the written text, from rule 2's set B runs and the same runs of set A | In each set, English at most 8 wrong words in 100, and Mandarin and mixed together at most 8 wrong characters in 100. Each is pooled over its messages. Each set's numbers, Mandarin alone and mixed alone are reported too. Not checked on the stand-in transcriber |
| 5 Only you send | In the same set B runs, reads every chat `--send-check` seconds after listening stops, then presses Enter in the field | No new message before Enter in any run. After Enter, one message with the field's text |
| 6 Speaking is typing | Speaks set B's first message in five cases: an empty field, text with the cursor at the end, text with the cursor in the middle, a picture attached, and a mention. Each case runs three times, each in a new Chrome: speak and send, type the spoken words at the same cursor and send, speak and press undo once | Speaking adds words at the cursor and nothing else, with the contract's leading space. Typing gives the same field and the same stored message, text and attachments. One undo gives back the starting field |
| 10 Your voice goes only where Rome says | Captures traffic through the set B runs, reads where Rome says speech becomes text, then scans the instance | Rome's read API and Settings page name a provider and host. Every request that carried audio went to that host or to the guardian's own Rome. The scan finds no audio |

### How rule 3 counts

`lib/text.mjs` holds the normalisation. Both texts fold full-width forms to half-width and drop case and punctuation. English counts words: hyphens split words, an apostrophe inside a word stays, numbers become words, and British spellings in the script become American. Mandarin and mixed count one token per Chinese character and one per Latin word, without spaces. Numbers become Chinese numerals, and a four-digit number before 年 is read digit by digit. Wrong tokens are the edit distance: substitutions, deletions and insertions.

## The transcriber comparison

```bash
node environments/voice-input/verifier/verify.mjs --rules 2,3 --transcriber soniox
```

`--transcriber` takes `soniox`, `elevenlabs`, `assemblyai`, `openai-live` (`gpt-live-transcribe`) or `openai-file` (`gpt-transcribe` on the finished recording, rule 3 only). The comparison streams each script recording straight to the provider at real time, in 100 ms chunks, without the product. It covers both sets and reports per set and language the wrong words or characters in 100, the median delay to first text and to complete text, how many messages meet rule 2's bar, and the price per hour. Delays count from the start of the audio, as rule 2 counts from the start click.

Credentials come from `SONIOX_API_KEY`, `ELEVENLABS_API_KEY`, `ASSEMBLYAI_API_KEY` and `OPENAI_API_KEY`, or from `NAME=value` lines in `~/.config/rome/voice.env` (`--secrets` sets another file). A provider without a credential is reported as "not checked: no provider credential", never as pass or fail. The same holds for rules 2 and 3 when the product's real transcriber has none.

The clients in `lib/providers.mjs` follow each provider's API reference as of 2026-11-14 and have not yet run against a real service. The prices come from secondary sources on the same date and the report says so.

## Contract with the environment

The environment's own README (`environments/voice-input/README.md`) is the contract. The verifier uses it as follows.

- **`version`** gives the product, environment and transcriber for the report. The verifier reads its own commit.
- **`env.sh reset`** runs before each verify run (`--reset` sets another command).
- **`browser --mic <wav> --lang en|zh-CN`** starts the Chrome for each script message, since the recording is fixed per launch. The verifier connects over `cdp` and uses the first page, already on the dashboard and signed in. It never sends `browser stop` mid-run, because that also stops the proxy that records traffic.
- **`transcriber stand-in --text <text>`** gives each message's written text on stand-in runs.
- **`chats`** and **`messages --chat <id>`**: the verifier knows no chat id in advance, so it compares snapshots of every chat's messages before and after each action. Messages compare by role, sender, text and attachments. `inputState` and the agent's error reply are ignored.
- **`capture start`** runs once the first Chrome is up, and **`capture stop`** after set B's 20 messages. Rule 10 reads its `audio` list.
- **`audio-scan`**: rule 10 fails on any finding.

Rome's read API names the transcriber's host as Rome's config has it, such as `transcriber:8790` for the stand-in, while the capture names it `transcriber (stand-in)`. Rule 10 compares host names without the port or the label.

## What the verifier assumes about the product

The rules' contract leaves these open. The planner has the list.

- **The usual send action** is Enter in the message field.
- **Rule 6's leading space**: one space goes before spoken text when the character before the cursor is neither a space nor a Chinese character, as the contract says. The case "text, cursor at the end" checks it.
- **A picture** is attached through an `input[type=file]` inside the message form.
- **A mention** is typed as `@`, which offers mentions as `option` elements, and Enter picks the first.
- **The Settings page** is `/settings`, and the place sits under its Advanced section, opened by a link, tab or button named "Advanced". The read API, `GET /api/voice-input` answering `{ place: { provider, host } | null }`, comes from the product builder. Both paths sit in `scenarios/r10-voice-goes-where-named.mjs`.
- **Audio through Rome**: a request carrying audio from the browser to the guardian's own Rome is allowed, since the rules route speech to the transcriber through it.

When a case cannot be set up, rule 6 reports that case as not checked and names what it needed.

## Tests

```bash
nix develop -c node --test environments/voice-input/verifier/test/*.test.mjs environments/voice-input/verifier/lib/*.test.mjs
```

`test/verify.test.mjs` runs the verifier against the stand-in product in `fake/server.mjs` through the fake `voice-env` in `fake/voice-env.mjs`. The fake prints what the real `voice-env` prints and starts Chromium from the devShell with a debugging port, as the real one does. The variant `good` must pass every phase 1 rule. Each `fail-<rule>` breaks one rule, and the verifier must fail that rule and pass every other. A short copy of the script, with both sets' text and 0.4 s of speech per message, keeps the suite near 3 minutes. The stand-in hears nothing: it schedules each message's written text on the message's word times.

## Adding a rule

Add a scenario under `scenarios/` that exports `{ rule, title, phase, run(ctx) }` and returns `ruleResult(checks)`, list it in `scenarios/index.mjs`, and teach `fake/server.mjs` a variant that breaks it.
