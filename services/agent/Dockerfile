# Wolfi glibc image. python:3.12-slim still carries unfixed Debian highs, and
# Playwright's manylinux wheel installs here. Digest-pinned latest-dev (Python 3.15).
FROM cgr.dev/chainguard/python:latest-dev@sha256:c179c7d8e23caed59a51ff74d4742f8f8d3f16af4c33c40acaf8d3ee07234592
USER root
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip==26.2.2 \
    && pip install --no-cache-dir -r requirements.txt
COPY worker.py parallel_reads.py browser.py guard.py plugins.py run_guard.py grounding.py retry.py resume.py compaction.py snapshots.py web_bot_auth.py video_analysis.py reply_text.py coding_jobs.py ./
ENV MALLOC_ARENA_MAX=2 \
    PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "worker.py"]
