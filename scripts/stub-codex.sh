#!/bin/sh
# Stand-in for the Codex CLI, used only by scripts/identity-smoke.sh.
#
# It records the request-scoped credential the platform handed to the
# Runtime for this turn, then holds the turn open so the smoke test can
# exercise a token while its Run is still active. It never prints the
# token to stdout.
#
# __TOKEN_FILE__ is substituted with an absolute path by identity-smoke.sh.
# The path cannot come from the environment: the AgentRunner deliberately
# passes only an allowlist of variables plus the request-scoped
# credentials to the child, which is exactly the behaviour we want.
TOKEN_FILE="__TOKEN_FILE__"

if [ "$1" = "--version" ]; then
  echo "codex 0.0.0-identity-smoke-stub"
  exit 0
fi

printf '%s' "${LAUNCHPAD_ACTION_TOKEN:-}" > "$TOKEN_FILE"
echo '{"type":"thread.started","thread_id":"smoke-thread"}'
sleep 120
