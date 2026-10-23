#!/bin/sh
set -e
# Same template expansion as tecnativa/docker-socket-proxy, plus a larger buffer.
# Container create inlines the Chrome seccomp profile (~22 KiB). HAProxy's
# default 16 KiB buffer rejects that request before it reaches dockerd.
sed 's/${BIND_CONFIG}/[::]:2375 v4v6/g' /usr/local/etc/haproxy/haproxy.cfg.template > /usr/local/etc/haproxy/haproxy.cfg
sed -i '/^global$/a\    tune.bufsize 65536' /usr/local/etc/haproxy/haproxy.cfg
exec haproxy -W -db -f /usr/local/etc/haproxy/haproxy.cfg
