FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir httpx playwright==1.49.1
COPY worker.py browser.py guard.py plugins.py run_guard.py grounding.py retry.py resume.py compaction.py ./
ENV MALLOC_ARENA_MAX=2 \
    PYTHONUNBUFFERED=1
CMD python worker.py
