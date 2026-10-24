FROM alpine:3.22
RUN apk add --no-cache iptables iptables-legacy python3
COPY computer-isolation.sh /opt/computer-isolation.sh
COPY isolation-guard/guard.py isolation-guard/rules.py /opt/
RUN chmod 755 /opt/computer-isolation.sh /opt/guard.py
ENV PYTHONUNBUFFERED=1 \
    ISOLATION_SOCKET=/run/teammates/isolation.sock \
    ISOLATION_SCRIPT=/opt/computer-isolation.sh
ENTRYPOINT ["python3", "/opt/guard.py"]
