# Video analysis v1

`watch_video` accepts a video library item id or a path under the calling bot's workspace. Uploaded chat attachments are indexed into the bot's library and can be addressed by that id. `ask_video` reuses the owner, bot, source reference, SHA-256 and `video-v1` cache entry. The API bridge checks the task lease and confirms the library source belongs to the calling bot and owner; workspace reads are confined to that bot's filesystem and denied secret filenames remain blocked. Cache rows are bot scoped, so another bot cannot infer or read a private analysis. No URL downloader is added.

The Python agent uses ffprobe for streams and duration, and ffmpeg for scene changes, two-second sampling, JPEG scaling, audio checks and MP3 chunks. Defaults cap videos at 60 minutes and 1 GB. Frame selection is capped at 30 per minute and 768 pixels on the long side. Audio without a stream, mean volume at or below -50 dB, or a low 300-3400 Hz to full-band energy ratio is skipped; the saved `audioSkipReason` records the choice. The band ratio is a cheap heuristic and can misclassify speech over music or unusual instrumentation.

Transcription defaults to `openai/whisper-large-v3-turbo` via `/audio/transcriptions`, with a 300 second chunk default (configurable with `VIDEO_STT_CHUNK_SECONDS`, capped at 600 seconds) and 48 kbps mono MP3, keeping chunks well below 25 MB. `VIDEO_STT_MODEL` and `VIDEO_STT_PROVIDER` configure the request. `VIDEO_SUMMARY_MODEL` overrides the existing planner model. Secrets stay in the API's existing `secret://openrouter/default` resolution path and the worker never receives or logs the key. The API proxy records STT and summary model requests through the existing usage store; completion events include STT seconds.

Summary requests are planned in five-minute ranges with at most 60 frames per range. The conservative estimate reserves 1,500 tokens per frame and 4 characters per text token under a 100,000 token ceiling. Multi-range results are merged in one final call. The cache stores transcript, timeline and sampled JPEG references for follow-up questions.

## Open issue

OpenRouter documents that `provider.order` and `allow_fallbacks` may not be honored on the transcription endpoint. The upstream request may also time out around 60 seconds, so the request pins the configured provider but cannot guarantee it was used. Returned provider metadata is retained when available. The endpoint's actual routing behavior needs confirmation from OpenRouter.
