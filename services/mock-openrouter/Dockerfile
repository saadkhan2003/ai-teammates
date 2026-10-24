FROM alpine:3.22
RUN apk add --no-cache python3
WORKDIR /app
COPY planner.py server.py ./
ENV PYTHONUNBUFFERED=1
CMD ["python3", "server.py"]
