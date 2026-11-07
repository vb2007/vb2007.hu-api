#!/usr/bin/env bash
set -e

API_LOG="$RUNNER_TEMP/${API_LOG_NAME:-api.log}"
MAX_ATTEMPTS=5
MAX_RETRIES=8

for ATTEMPT in $(seq 1 $MAX_ATTEMPTS); do
  API_PORT=$(node -e 'const server = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')
  sed -i '/^\(APP_PORT\|CORS_ORIGIN_URLS\|GITHUB_CALLBACK_URL\)=/d' .env
  echo "APP_PORT=$API_PORT" >> .env
  echo "CORS_ORIGIN_URLS=http://localhost:$API_PORT" >> .env
  echo "GITHUB_CALLBACK_URL=http://localhost:$API_PORT/auth/github/callback" >> .env
  echo "Attempt $ATTEMPT/$MAX_ATTEMPTS: API will listen on port $API_PORT"

  UV_THREADPOOL_SIZE=8 node ./dist/index.js > "$API_LOG" 2>&1 &
  API_PID=$!
  echo "API_PID=$API_PID" >> $GITHUB_ENV

  # Waiting for the API to start
  RETRY_COUNT=0
  echo "Waiting for API to be ready..."

  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if ! kill -0 "$API_PID" 2> /dev/null; then
      echo "API exited before it was ready, retrying with a new port"
      tail -n 50 "$API_LOG"
      echo "API_PID=" >> $GITHUB_ENV
      continue 2
    fi

    if ss -ltnpH "sport = :$API_PORT" | grep -q "pid=$API_PID," &&
      curl -sf "http://127.0.0.1:$API_PORT/healthz" > /dev/null; then
      echo "API is ready!"
      exit 0
    fi

    echo "API not ready yet, retrying in 3s..."
    sleep 3
    RETRY_COUNT=$((RETRY_COUNT + 1))
  done

  echo "API failed to start within the timeout period"
  tail -n 50 "$API_LOG"
  exit 1
done

echo "API failed to start after $MAX_ATTEMPTS attempts"
exit 1
