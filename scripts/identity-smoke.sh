#!/usr/bin/env bash
# Build the platform, start it with a stub Runtime, and run the
# end-to-end identity and authorization checks over real HTTP.
#
#   ./scripts/identity-smoke.sh
#
# No container engine, no Ark key and no network access are required.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-3111}"
WORK="$(mktemp -d)"
TOKEN_FILE="$WORK/token"
export LAUNCHPAD_SMOKE_TOKEN_FILE="$TOKEN_FILE"

# Bake the capture path into a per-run copy of the stub. It cannot be
# passed through the environment, because the AgentRunner only forwards an
# allowlist plus the request-scoped credentials - which is the point.
sed "s|__TOKEN_FILE__|$TOKEN_FILE|" scripts/stub-codex.sh > "$WORK/stub-codex.sh"
chmod +x "$WORK/stub-codex.sh"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "Building..."
npm run build --silent

echo "Starting the platform on port $PORT with a stub Runtime..."
NODE_ENV=production \
HOST=127.0.0.1 \
PORT="$PORT" \
LOG_LEVEL=warn \
APP_DATA_DIR="$WORK/data" \
AGENT_WORKSPACE_ROOT="$WORK/workspaces" \
CODEX_HOME="$WORK/codex" \
CODEX_BIN="$WORK/stub-codex.sh" \
RUNTIME_PROVIDER=local-process \
ARK_API_KEY=smoke-test-key \
ARK_MODEL=ep-smoke-test \
LAUNCHPAD_TOKEN_SECRET=identity-smoke-test-secret-value \
  node apps/server/dist/index.js > "$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null; then break; fi
  sleep 0.25
done

SMOKE_BASE_URL="http://127.0.0.1:$PORT" node scripts/identity-smoke.mjs
