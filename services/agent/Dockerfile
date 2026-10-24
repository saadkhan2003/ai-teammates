FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir httpx playwright==1.49.1
COPY worker.py parallel_reads.py browser.py guard.py plugins.py run_guard.py grounding.py retry.py resume.py compaction.py snapshots.py web_bot_auth.py video_analysis.py reply_text.py ./
ENV MALLOC_ARENA_MAX=2 \
    PYTHONUNBUFFERED=1
CMD python worker.py
