# Desktop tools and evidence

The agent can capture a screenshot, click, type, press keys, scroll, and record its own desktop. Click and scroll coordinates use a 1280 × 800 model space and scale to `DISPLAY_GEOMETRY`. Existing direct computer click calls keep native pixel coordinates unless `coordinateSpace` is `model`.

Screenshot and recording artifacts are attached to the task with names beginning `evidence-`. The task evidence API exposes metadata to the owning user; the existing artifact download route serves images inline and videos with byte-range support. The chat displays lazy images and video controls under the latest task's final response.

Desktop input tools require agent control. They return a paused result when the user has taken control. Recordings continue during a takeover and stop when the agent calls `record_stop`; recordings are capped at 600 seconds, run as the bot workspace user, and are limited to 50 MB when stored as an artifact. The computer image uses VP9/WebM when available and falls back to H.264/MP4.

The mock planner accepts `EVIDENCE DEMO` to capture an image, start and stop a short recording, and return a final response for acceptance testing.
