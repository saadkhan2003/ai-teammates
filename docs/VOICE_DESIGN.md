# Voice: dictation, live calls and voice replies

Status: live voice calls and voice replies are design-only and not built. The existing composer shortcut has basic browser dictation through `SpeechRecognition`; it does not implement the call, transcript-card, or voice-reply design below. Written 2026-10-24 (Asia/Karachi). Day counts, prices and latencies below are **estimates** unless a figure is quoted from a page I fetched this session. Provider prices change; re-check before you commit money to one.
Tags: **[confirmed]** (read on a fetched page or in the repo this session), **[inferred]**, **[guess]**.
Voice is a non-goal in `docs/V0_5_PLAN.md`; this is a design for after that, or as a v0.6 slice.
Honesty note: I did not open the reference screenshots stored with this task, so the UX below comes from Grok Bot's written docs and changelog, not from pictures. Visuals should be compared against the screenshots before building.

## 1. What the three features are (Grok Bot's behaviour)

### 1.1 Dictation, the mic in the composer [confirmed]
Sources: https://cursor.com/help/grok-bot/voice-chat , https://x.ai/changelog/bot , https://docs.x.ai/grok-bot/chat-and-collaboration
- Dictation types what you say into the message box so you can edit it before sending. Shortcut: Cmd/Ctrl+D (the shortcut list is in the Grok Bot app; AI Teammates already maps `d` to a `dictate` action in `apps/web/lib/shortcuts.ts`).
- Changelog lines: Enter while dictating **stops** recording; a "send" press during dictation sends the transcript as soon as it is ready; the app detects the spoken language; there is a microphone choice in Settings (the `microphone` row under General, seen in `/home/box/reference/app-ui.md`).
- Errors shown in the app are plain: no mic found, permission denied. **[inferred from the help page headings; I did not see exact strings except the call errors in 1.2.]**

### 1.2 Live voice chat with a bot [confirmed]
- **Entry**: a waveform "Start voice chat" button in the composer, shown **only while the composer is empty**. Once you type, it becomes the Send button. [chat-and-collaboration docs and help page]
- **States**: `Connecting…` (desktop) or `Calling…` (phone), then live. While live: waveform of the user's voice, the Bot's speaking indicator, and a bar with **Mute / Unmute**, **Hang up**, **Show transcript**, **Show settings**.
- **Settings in the call**: Voice, Speed (0.5x offered), Language with **Auto-detect**. These are saved **per Bot**.
- **Rules**: one call at a time. Starting another shows "End the current voice chat?" with End and Chat. A call keeps running while you browse other chats; the sidebar shows "Voice chat in progress" and a "Return to the voice chat" action. No group chats.
- **Resilience**: if the connection drops, it reconnects and continues in the same conversation. The Bot can answer while you are muted (the mute is only the mic). Hanging up while the Bot is still working: it finishes and posts the result in chat. A call wakes a sleeping computer.
- **Errors** (exact strings from the changelog): `Voice chat failed`, `The call ended unexpectedly.`, `The realtime connection failed.`, each with a Dismiss. "Realtime" in that last string suggests a realtime speech API under the hood **[inferred]**.
- **Transcript**: live captions extend a line when you pause then keep talking; background-noise tags are stripped. After hangup the chat gets a **receipt with the duration** and a **Voice chat card** that opens the transcript, with "How was the call?" Good/Bad.
- **Context**: a call knows the user's local date, and draws on earlier calls and recent chat with that Bot.

### 1.3 Voice replies / voice memos [confirmed]
- A Bot can send a reply as a **voice memo**: a chat message with Play/Pause, an expandable transcript, and a **word-by-word highlight in sync with the audio**; clicking a word jumps to it. Anyone in the chat can play it.
- On the Grok Bot box, the `voice` skill says a memo is a `SendToUser` message of type text with `voice_memo: true`, and **the app speaks the text**; the model never produces audio itself. **[confirmed from the box skill file]** Word highlight needs per-word timing, so the speech source must return timestamps or the client must estimate them **[inferred]**.

### 1.4 How the live call is built [confirmed on the box, inferred beyond]
From the box `voice` skill: a **separate, lightweight voice agent** talks to the user in real time and **relays work requests to the main Bot** as an inbound message on a `voice:<call>` channel. The main Bot replies on that channel with **plain text only** (no markdown, no files, no cards) because it will be spoken. The call is saved as a **JSON file under `voice-calls/`** (the transcript), and the chat shows only a duration receipt plus the Voice chat card. Hanging up does not cancel work in progress.
Takeaways for us: (1) keep the speech loop separate from the heavy agent so the talk stays fast; (2) the heavy agent stays the only actor with tools, approvals and DLP; (3) the transcript is a saved artifact.

## 2. Where AI Teammates stands today [confirmed in the repo]
| Piece | State |
|---|---|
| Dictation | `app-shell.tsx` ~line 249: the `dictate` shortcut calls the browser `SpeechRecognition` and nothing more (no UI, no timer, no error states, no language). |
| Composer (`chat-pane.tsx`) | "+" menu, text area, Send and Stop buttons. No mic or call button. |
| Recording helper | `lib/recording.ts` has `formatTimer`, `CHUNK_BYTES` 60 KB, `MAX_RECORDING_BYTES` 60 MB, and a canvas `MediaRecorder` for screen recordings (no audio track). Reusable parts: timer, chunk upload pattern, size cap. |
| Audio endpoints | `services/mock-openrouter` has no audio routes, so tests have no STT or TTS mock. |
| Upload path | Artifacts table plus `/api/artifacts/...` download (Routes.cs ~729). Good for memo audio. |
| WebSocket pattern | `Routes.cs` ~772 `/vnc/websockify` shows the accept/pump pattern and token-in-query auth. Browsers cannot set an Authorization header on a WebSocket, so the voice socket needs the session cookie or a short-lived token. |
| Caddy | `/api/events` and `/vnc/*` have `flush_interval -1` and no timeouts. **No `Permissions-Policy` header**, so the microphone is allowed by default for same origin; add an explicit `microphone=(self)` for clarity. TLS is `tls internal`; the mic requires a secure context, see section 9. |
| Provider base | `Platform.cs` reads an `OPENROUTER_BASE`-style env, so provider URLs are swappable. |
| Memory | Call transcripts could feed the new memory pass (see MEMORY_NOTES_DESIGN.md). |

## 3. Browser building blocks [confirmed, MDN and provider docs]
- `navigator.mediaDevices.getUserMedia({audio:true})`: only in a **secure context** (HTTPS or localhost). Error names to map to UI: `NotAllowedError` (denied, or blocked by Permissions-Policy), `NotFoundError` (no mic), `NotReadableError` (hardware or OS busy), `OverconstrainedError` (chosen device gone), `TypeError` (bad constraints). Source: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- `MediaRecorder.isTypeSupported()` must be used to pick a container; there is no universal format. Typical result **[general knowledge, not re-verified here]**: Chrome and Firefox give `audio/webm;codecs=opus`, Safari gives `audio/mp4`. Source: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static
- Web Speech API `SpeechRecognition`: in Chrome it normally sends audio to a **server operated by the browser vendor**; there is an on-device mode (`processLocally`, with `available()` and `install()`) and phrase hints. Support is uneven across browsers. Source: https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API . Good as a zero-cost fallback; unacceptable as the only path for a product that promises DLP, because the audio leaves to a third party outside our control.
- For a live call, capture PCM16 with an `AudioWorklet` (low latency, fixed sample rate **[guess]** 16 kHz for STT and 24 kHz for TTS playback) rather than MediaRecorder chunks, which are container-framed and add delay.
- Safari quirks [confirmed in xAI's voice-agent cookbook and general experience]: create/resume the `AudioContext` inside a click handler; blob audio `duration` may read `Infinity`.

## 4. Provider facts

### 4.1 OpenRouter (our default gateway) [confirmed]
Sources: https://openrouter.ai/docs/guides/overview/multimodal/stt , https://openrouter.ai/docs/guides/overview/multimodal/audio , https://openrouter.ai/blog/announcements/announcing-audio-apis/ , https://openrouter.ai/blog/tutorials/text-to-speech/ , https://openrouter.ai/blog/announcements/elevenlabs-on-openrouter/
- **STT**: `POST /api/v1/audio/transcriptions`. Models listed: `openai/whisper-1`, `openai/whisper-large-v3`, `openai/gpt-4o-transcribe`, Google Chirp 3, Groq Whisper, ElevenLabs Scribe v2. It is a **request/response** API (send a recorded clip, get text). Provider routing options (zero data retention, data collection) are documented on the same pages.
- **TTS**: `POST /api/v1/audio/speech`, OpenAI-compatible request shape, streaming audio back.
- **No realtime speech-to-speech socket.** An open issue in OpenRouterTeam/ai-sdk-provider (https://github.com/OpenRouterTeam/ai-sdk-provider/issues/53) and the absence from the docs confirm there is no realtime API. So an OpenRouter-only path **must be a cascade**: STT, then LLM, then TTS.
- Exact prices per model: **not read from the pages**; look at the model pages when choosing. I carry the search-summary figure that OpenAI-hosted transcription is about $0.0045 to $0.017 per minute **[unverified, may be stale]**.

### 4.2 xAI [confirmed, docs.x.ai]
Sources: https://docs.x.ai/developers/model-capabilities/audio/speech-to-text , .../text-to-speech , .../voice , .../speech-to-speech , .../ephemeral-tokens , https://docs.x.ai/cookbook/examples/voice-agent-web
- **STT** `POST /v1/stt` (model `grok-voice-transcribe-2.0`) and streaming `wss /v1/stt` with interim results, smart-turn detection and a `finalize` message for push-to-talk. Listed rates in the docs I read: about $0.10 per hour batch and $0.20 per hour streaming **[figures from my fetch notes; re-check]**.
- **TTS** `POST /v1/tts` and a bidirectional WebSocket (`text.clear` to cut speech on barge-in; `with_timestamps` returns word timing, which is exactly what word-highlight needs). Per-request limit 60,000 characters and 50 concurrent TTS sessions per team **[from my fetch notes]**.
- **Realtime voice agent**: `wss://api.x.ai/v1/realtime`, OpenAI-Realtime-compatible event protocol, server VAD, tool calling, session resumption, ephemeral tokens so the browser never holds the API key. Listed at about $0.08 per minute **[from my fetch notes; re-check]**.

### 4.3 OpenAI Realtime [confirmed pages, figures unverified]
Sources: https://developers.openai.com/api/docs/guides/voice-webrtc , .../realtime-conversations , .../realtime-vad , https://developers.openai.com/api/reference/resources/realtime/client-events
- WebRTC is the recommended browser transport (ephemeral client secret minted by our server); WebSocket is for server-to-server. Barge-in: `interrupt_response` with server VAD; on WebSocket you must send `conversation.item.truncate` to align server and client playback.
- Audio-token pricing from a search summary: about $32 and $64 per million input/output audio tokens on the newest realtime model **[unverified; do not budget from this]**.

### 4.4 Reference patterns [confirmed docs]
Pipecat interruptions (https://docs.pipecat.ai/pipecat/fundamentals/interruptions) and LiveKit agent sessions (https://docs.livekit.io/agents/logic/sessions/): VAD plus turn-detection decide when a user turn ends; on interruption you cancel TTS and **flush the client playback queue**, and you trim the assistant text to what was actually spoken.

## 5. Architecture options

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Browser-only dictation** (Web Speech) | Existing `dictate` path | Free, instant, already half built | Audio goes to the browser vendor; not available everywhere; no language control; no DLP; no call or memo |
| **B. Record then transcribe on the server** | MediaRecorder, POST clip, OpenRouter `/audio/transcriptions` | Works with our gateway and key handling; any browser; DLP and audit possible; swap models | No live partial text (shown after stop); clip size cap |
| **C. Streaming STT proxied by our API** | Browser PCM over our WebSocket, API forwards to xAI `wss /v1/stt` | Live captions, fast stop-to-text | Needs a provider with streaming STT (xAI or OpenAI), not OpenRouter; more moving parts |
| **D. Cascaded call** | Mic PCM, our WS, VAD/turn end, STT, **the normal bot task**, TTS stream back | Works on OpenRouter-compatible providers; reuses bot tools, policy and DLP; transcripts are exact | Higher latency (**[guess]** 1.5 to 3 s to first audio); we own VAD and barge-in logic |
| **E. Realtime speech-to-speech voice agent** | Browser to our WS (or ephemeral token direct), xAI or OpenAI realtime; one function tool `ask_teammate` hands work to the bot | Lowest latency (**[guess]** under 1 s), native barge-in and turn detection, mirrors Grok Bot's two-agent design | Not on OpenRouter; separate provider key and cost; speech model is a second "brain" that must be kept from acting on its own |

### Recommendation
1. **Dictation = B**, with A as fallback when the server path is unavailable and the user opts in. Smallest build, secure by default, immediately useful.
2. **Voice replies = TTS from our server** (OpenRouter `/audio/speech`, or xAI TTS for word timestamps), cached as an artifact.
3. **Live call = D first, E as a provider adapter.** Build D because it runs on the infrastructure we already trust (OpenRouter plus our own task runner), then add E behind the same `IVoiceSession` interface for users who bring an xAI or OpenAI key and want snappier calls. In E, the speech model only talks; anything that needs tools becomes `ask_teammate(request)`, which creates a normal task, so Policy.cs approvals and DLP still apply. This is the same split Grok Bot uses (talk agent plus main Bot).
4. **Keep API keys server-side.** Where the provider supports ephemeral tokens (xAI, OpenAI), E may let the browser connect directly later; for v1 proxy through our WebSocket so audit and DLP see everything.

## 6. UX specification (our own look, same behaviours)

### 6.1 Composer controls
- Composer empty: a **waveform/call button** at the right (starts a call) and a **mic button** to its left (dictation). Composer has text: the call button turns into **Send**; the mic stays.
- Streaming reply in progress: Stop replaces Send (already built); mic and call are disabled with a tooltip.
- Mic button tooltip: "Dictate (Ctrl+D)". Tooltip text uses Cmd on macOS.

### 6.2 Dictation states
1. **Idle**: mic icon.
2. **Asking permission**: browser prompt; composer shows "Allow the microphone to dictate" while pending.
3. **Recording**: composer text area is replaced by a pill: red dot, live **waveform** (from an `AnalyserNode`), **timer** (`formatTimer`), **Cancel (x)** and **Done (check)**. Enter = Done; Esc = Cancel. Same shortcut again toggles. Max length **[guess]** 5 min, with a countdown in the last 10 s.
4. **Transcribing**: pill shows a spinner and "Transcribing…". Cancel allowed.
5. **Done**: the text is **inserted at the caret** in the composer (not sent), cursor placed at the end, focus returned. If the user chose "send" (check button long-press or Enter on a second press **[guess]**), send as soon as the transcript lands, like Grok Bot's changelog line.
6. **Errors** (inline red-free muted banner above the composer, Dismiss; never a modal):
   - `NotAllowedError`: "Microphone blocked. Allow it in the browser's site settings, then try again." with a "How" link to the help text.
   - `NotFoundError`: "No microphone found."
   - `NotReadableError`: "Your microphone is in use by another app."
   - `OverconstrainedError`: "That microphone is no longer available. Using the default one." and retry once.
   - Not a secure context: "Voice needs HTTPS. Open the app at the https address."
   - Server STT failed or timed out: "Couldn't transcribe. Try again." plus **Keep recording** (the clip is still held in memory so retry does not need re-speaking).
   - Empty transcript: "Didn't catch anything."
   - Network offline: keep the clip and offer Retry.
7. **Language**: Auto-detect by default (provider detects); optional override in Settings > General next to the mic selector. **Microphone selector** lists `enumerateDevices()` audio inputs after permission is granted.

### 6.3 Live call states
Call screen is a **bar docked above the composer** (like Grok Bot's, which keeps you in the chat) that expands to a panel; it keeps running if you switch chats, the sidebar row of that bot shows "Voice chat in progress", and a "Return to the voice chat" link appears in other chats.
1. **Starting**: `Connecting…`. Timeout **[guess]** 15 s, then "Voice chat failed" with Retry.
2. **Listening**: waveform of the user's mic, label "Listening".
3. **Thinking**: subtle pulsing dots, label "Thinking" (STT done, waiting on the bot or the first TTS bytes). If the bot task will take long, the voice agent says one short filler line ("Working on it") and goes quiet; the final result is spoken when ready, or posted in chat if the user hung up.
4. **Speaking**: bot waveform; speech text appears in captions as it is spoken.
5. **Muted**: mic icon struck through; audio keeps flowing to the bot's speaker; the bot can still speak. VAD is paused so noise is not sent.
6. **Barge-in**: user speech while the bot speaks cuts the bot's audio within about 200 ms **[guess]**: send `cancel` to TTS, flush the playback queue, and trim the bot's saved text to what was spoken.
7. **Reconnecting**: "Reconnecting…" up to 30 s **[guess]**, then continues in the same call record; after that "The call ended unexpectedly."
8. **Ended**: bar disappears; chat gets a **receipt** ("Voice chat, 4:12") and a **Voice chat card** that opens the transcript (turns with timestamps), and a small "How was the call?" Good/Bad.
Buttons: **Mute/Unmute**, **Hang up**, **Show transcript** (side panel with live captions), **Show settings** (Voice, Speed 0.5x to 2x, Language with Auto-detect, saved per bot). Only one call at a time; a second start asks "End the current voice chat?" End / Chat. No calls in group chats. Keyboard: Space toggles mute while the panel is focused; Esc does nothing (avoid accidental hangup).
Spoken-reply rules for the bot (injected into the call prompt, mirrors the box skill): short sentences, no markdown, no links read out, say numbers naturally, never read secrets; if the answer is long or structured, say "I put the details in chat" and post a normal message.

### 6.4 Voice memo states
- Message with `voice_memo`: card with **Play/Pause**, a thin progress bar, duration, speed chip (1x/1.5x/2x), **Transcript** expander. While playing, the current word is highlighted; clicking a word seeks to it (needs word timestamps, section 7.4).
- Generating: "Preparing audio…" placeholder; text is already readable (never block the text on TTS).
- TTS failure: card shows the text and "Audio unavailable, Retry".
- Autoplay: **off**; browsers also block it without a gesture.
- Per-bot setting "Reply with voice when I send a voice message" **[guess, nice-to-have]**.

## 7. Technical design

### 7.1 API surface
| Endpoint | Purpose |
|---|---|
| `POST /api/voice/transcribe` (multipart: audio, mime, language?) | Dictation. Auth cookie. Size cap and duration cap. Calls the STT adapter, runs DLP on the result, returns `{text, language, duration_ms}`. Audio is **not stored**. |
| `POST /api/voice/speak` (json: message_id or text, voice, speed) | Memo TTS. Returns artifact id plus optional word timing JSON. Cached by hash of (text, voice, speed, provider). |
| `GET /api/voice/config` | Which providers exist, voices, languages, max lengths; lets the UI hide buttons that cannot work. |
| `WS /api/voice/call?bot=...` | Live call. Short-lived ticket in the query (minted by an authenticated POST), because browsers cannot set headers on a WebSocket. Binary frames: mic PCM16 up, TTS audio down. JSON frames: state, captions, mute, settings, hangup. |
| `POST /api/voice/calls/{id}/rate` | Good/Bad. |
| `GET /api/voice/calls/{id}` | Transcript for the card. |

Caddy: add `handle /api/voice/call` with `flush_interval -1` and `read_timeout 0 / write_timeout 0` **before** `handle /api/*` (same as `/api/events`); add `Permissions-Policy: microphone=(self)` to the shared header block.

### 7.2 Provider adapters (C# interfaces, server side)
`ISttProvider.Transcribe(stream, mime, lang)`, `ISttStream` (optional streaming), `ITtsProvider.Synthesize(text, voice, speed, wantTimestamps)` and `StreamAsync`, `IVoiceSession` for realtime providers. Implementations: `OpenRouterStt`, `OpenRouterTts`, `XaiStt`, `XaiTts`, `XaiRealtime`/`OpenAiRealtime` (same protocol, different base URL). Provider choice per user in Settings with a default; provider calls tagged in `model_calls` with an `audio_seconds` or `chars` column so costs are visible.

### 7.3 Cascaded call loop (option D)
1. Browser opens the WS, sends `start{bot, language, voice}`. Server creates `voice_calls` row, loads the bot's memory block and recent call summaries, and checks the one-call-per-user rule.
2. Audio frames go through **server VAD** (e.g. an ONNX Silero-style VAD or a simple energy plus hangover filter first **[guess: start simple]**). End of turn = **[guess]** 600 to 800 ms of silence, tuned per language; "smart turn" later.
3. Utterance goes to STT (batch per utterance on OpenRouter; streaming if xAI).
4. Transcript is DLP-scanned; secrets are dropped from what is written to the transcript and from what is sent to the model (the user is told: "I can't take passwords by voice; I'll put a secure form in chat").
5. Text goes to the **voice agent** (a small fast model with a short system prompt and the bot's persona and memory block). It either answers directly or calls `ask_teammate(request)`, which creates a normal task on the bot's queue. The task result returns as plain text to be spoken, tagged channel `voice:<call>` (exactly as the Grok Bot box does it).
6. Reply text streams to TTS in sentence chunks; audio frames stream to the browser; the browser plays through a jitter buffer (`AudioContext` created on the click that started the call).
7. On barge-in: cancel TTS, drop queued audio, mark the assistant turn as `interrupted` with the spoken prefix.
8. Hangup: close WS, finalise transcript, write the transcript artifact, post receipt and card messages, run the memory pass over the transcript, keep running tasks alive.

### 7.4 Word highlight
Prefer TTS with timestamps (xAI `with_timestamps`). If the provider has none, estimate per-word timing from character counts and total duration **[guess; works but drifts]**. Store timings JSON as an artifact next to the audio.

### 7.5 Data model (next migration number after `025`; check at build time)
```sql
CREATE TABLE voice_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL, bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  provider text NOT NULL,              -- 'cascade:openrouter' | 'xai-realtime' | 'openai-realtime'
  started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  end_reason text,                     -- hangup | dropped | error | idle | cap
  duration_ms int, voice text, speed real, language text,
  transcript_artifact_id uuid, rating smallint,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb);   -- audio seconds, tts chars, stt seconds, tokens, estimated cost
CREATE TABLE voice_turns (
  id bigserial PRIMARY KEY, call_id uuid NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  seq int NOT NULL, speaker text NOT NULL,  -- 'user' | 'bot'
  text text NOT NULL, started_ms int, ended_ms int, interrupted boolean NOT NULL DEFAULT false);
```
Messages: new `kind` values (or `parts` types, see `MessageParts.cs`) `voice_memo` (text plus `audio_artifact_id`, `timings_artifact_id`, `duration_ms`) and `voice_call` (call id, duration, rating). Audio files live in `artifacts`; **raw call audio is not stored** by default.

### 7.6 Front end
- `lib/voice/` : `recorder.ts` (mime pick via `isTypeSupported`, MediaRecorder, analyser levels), `permissions.ts` (error mapping, `permissions.query` where available), `call-client.ts` (WS, AudioWorklet capture, playback queue, reconnect), `player.ts` (memo player with word sync).
- Components: `MicButton`, `RecordingPill`, `CallButton`, `CallBar`, `CallPanel`, `VoiceMemoCard`, `VoiceCallCard`, `MicSettings` (device picker + test meter).
- State: one `VoiceProvider` context (single active call, survives chat switches) so "Return to the voice chat" works.

## 8. Costs and limits (estimates, check before relying)
- **Dictation, option B**: batch STT at roughly $0.10 to $1.00 per hour of audio depending on model **[from the figures above; wide band]**, i.e. a 20-second dictation costs a fraction of a cent. Treat as negligible; cap at 5 min and 10 MB per clip **[guess]** and 100 clips per user per day **[guess]**.
- **Memo TTS**: roughly 900 characters per spoken minute **[guess]**; at an xAI-style price in the tens of dollars per million characters this is about a cent or two per minute **[estimate]**. Cache so replays are free. Cap 2,000 characters per memo by default **[guess]**.
- **Call, cascade (D)**: STT plus TTS plus the voice-agent model plus any bot tasks. **[guess]** about $0.05 to $0.15 per minute, dominated by the LLM turns and TTS. Measure with real numbers before publishing a limit.
- **Call, realtime (E)**: xAI listed about $0.08 per minute (about $0.80 for a 10-minute call) **[figure from my fetch notes]**; OpenAI is token-priced and probably higher **[unverified]**.
- **Guard rails (all guesses)**: one active call per user; max call length 30 minutes; idle timeout 2 minutes of silence; daily voice budget per user with a visible meter in Settings; global kill switch env flag `VOICE_ENABLED`.
- **Testing budget**: use mock provider endpoints only. Real-provider smoke tests stay inside the existing $0.50 OpenRouter test cap (a few short clips).

## 9. Security, privacy and abuse
- **Mic permission**: requested only on click, never on page load. Secure context required: `tls internal` means a self-signed cert on the LAN, so a phone needs the CA trusted or a real hostname, otherwise `getUserMedia` fails; call this out in the setup docs. Add `Permissions-Policy: microphone=(self)`; no third-party iframes get the mic.
- **Keys**: provider keys stay in the API process. If ephemeral tokens are used later, scope them to one session and a few minutes.
- **Data minimisation**: dictation audio is held in browser memory and the API request only; not written to disk or the DB. Call audio is not stored. Transcripts are stored (section 7.5) with the same retention as chat; "Delete call" removes `voice_turns`, artifact and messages.
- **Provider routing**: for OpenRouter requests send the documented data-collection and zero-retention preferences by default, and show the active provider name in Settings so the user knows where audio goes. **Web Speech fallback is opt-in** with a one-line warning that the browser vendor processes the audio.
- **DLP**: scan every transcript chunk with `Dlp` before it is written to chat, memory or logs. Spoken card numbers, OTPs, tokens are masked in the stored transcript and the bot is told "the user said something sensitive; ask them to use a secure form". The voice agent must **never** run `type_secret` or `request_login` by voice; those render as cards in chat only (same as Grok Bot's secure forms).
- **Prompt injection by voice**: transcript text is user input but may include speech from a TV or another person. The voice agent has no tools except `ask_teammate`; approvals for irreversible actions are never accepted as "yes" by voice; they require tapping the approval card (Grok Bot's changelog says its Bots check your own messages before irreversible actions, which supports this stance). **[inferred design choice]**
- **Audit**: `audit_events` rows `voice.call.start/end`, `voice.transcribe`, `voice.speak` with ids, provider, duration, bytes, cost estimate. No transcript text and no audio in audit rows. 
- **Consent**: the call bar shows "Transcribed" and the first-use sheet explains what is sent where. Group chats are excluded, so no third-party recording problem in v1.
- **Abuse limits**: per-user rate limits, one concurrent call, size and duration caps, WS origin check, ticket single-use.
- **Accessibility**: captions always on in the panel; keyboard control for every button; reduced-motion for waveforms.

## 10. Test plan
1. Unit: mime picker; error mapper for each DOMException name; timer; turn detection with canned PCM; DLP on transcripts; TTS cache key.
2. Mock provider: add `/audio/transcriptions` and `/audio/speech` (and a fake realtime WS) to `services/mock-openrouter` returning deterministic text and a short WAV.
3. Playwright: Chromium with its fake-media flags (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, and `--use-file-for-fake-audio-capture=<wav>`) **[general practice, not verified in this repo]**: dictation flow (record, Done, text in composer), Cancel, Esc, Ctrl+D, permission denied path (context without permission), no-device path, STT error and retry.
4. Playwright for the call: start, captions appear, mute, hang up, receipt and card, second start shows the confirm dialog, switch chats keeps the bar, drop-and-reconnect (kill WS from the test).
5. Integration: one-call-per-user, ticket expiry, budget cap, transcript saved after abrupt close, hangup while a task runs does not cancel it, cross-user access to a call returns 404.
6. Manual checklist on Safari, Chrome and a phone: audio playback unlock, background tab, Bluetooth headset switching, echo with speakers (needs `echoCancellation: true`), autoplay blocked.
7. Latency eval for D: record time from end of speech to first TTS byte over 30 scripted turns; target **[guess]** p50 under 2.5 s.

## 11. Build order (all day counts are estimates)
| # | Step | Estimate |
|---|---|---|
| 1 | `VOICE_ENABLED` flag, `/api/voice/config`, Permissions-Policy header, mic permission helper, device picker in Settings > General | 1 d |
| 2 | Provider adapter interfaces plus OpenRouter STT/TTS, mock endpoints in `mock-openrouter` | 1.5 d |
| 3 | **Dictation MVP**: `/api/voice/transcribe`, recorder, pill UI (waveform, timer, Cancel/Done), insert into composer, Enter/Esc/Ctrl+D, error states, language auto | 3 d |
| 4 | Dictation tests and Safari/mobile pass | 1 d |
| 5 | **Voice memo**: `voice_memo` message part, TTS endpoint with artifact cache, player card, transcript expander, per-bot voice/speed settings | 3 d |
| 6 | Word timing and click-to-seek (xAI timestamps or estimation) | 1.5 d |
| 7 | **Call backend (cascade)**: ticketed WS, session manager, VAD and turn end, STT, voice-agent prompt, `ask_teammate` channel to a normal task, TTS streaming, barge-in, `voice_calls` and `voice_turns`, Caddy handle | 5 d |
| 8 | **Call UI**: waveform call button, CallBar and panel, states, mute, hang up, captions, settings, one-call rule and confirm, sidebar indicator and Return link, reconnect | 4 d |
| 9 | Post-call: transcript artifact, receipt, Voice chat card, rating, memory pass hook, "Delete call" | 1.5 d |
| 10 | Security pass: DLP on transcripts, audit events, rate and budget limits, consent sheet, docs in `SECURITY.md` | 1.5 d |
| 11 | Realtime provider adapter (xAI, OpenAI-compatible) behind `IVoiceSession` with the single `ask_teammate` tool | 3 d |
| 12 | Full Playwright suite, latency eval, manual device checklist, CHANGELOG | 2.5 d |
| | **Total** | **about 29 days one engineer; about 17 to 20 calendar days with parallel agents** (estimates) |

Shippable slices: after step 4 (dictation, about 6.5 d), after step 6 (voice replies, about 11 d), after step 10 (calls, about 24 d); step 11 is optional polish.

## 12. Open decisions for Saad
1. OK with cascade first (OpenRouter-only, slower) and realtime as a later optional adapter?
2. Which TTS provider: OpenRouter's (one key) or xAI's (word timestamps, extra key)?
3. Allow the Web Speech fallback at all (audio goes to the browser vendor)?
4. Store call transcripts forever, or auto-delete after N days?
5. Is HTTPS on the LAN with a trusted cert available for phone testing?
