FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends iptables python3 \
    && rm -rf /var/lib/apt/lists/*
COPY computer-isolation.sh /opt/computer-isolation.sh
COPY isolation-guard/guard.py /opt/guard.py
RUN chmod 755 /opt/computer-isolation.sh /opt/guard.py
ENV PYTHONUNBUFFERED=1 \
    ISOLATION_SOCKET=/run/teammates/isolation.sock \
    ISOLATION_SCRIPT=/opt/computer-isolation.sh
ENTRYPOINT ["python3", "/opt/guard.py"]
