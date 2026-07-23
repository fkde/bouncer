#!/usr/bin/env bash
# entrypoint.sh — run Bouncer, with Ollama either INSIDE this container
# (default) or on an EXTERNAL host (e.g. native, GPU/Metal-accelerated Ollama).
#
# Mode is auto-detected from OLLAMA_URL:
#   * host is 127.0.0.1 / localhost  -> internal: start `ollama serve` here
#   * anything else (e.g. host.docker.internal) -> external: use that daemon,
#     do NOT start a local one (this is the Apple Silicon acceleration path)
# Override the auto-detection with OLLAMA_INTERNAL=1 or =0 if needed.
#
# Models are pulled against whichever daemon is in use. If a managed process
# exits, the script exits so Docker's restart policy restarts the container.
set -u

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# --- Derive the CLI target (OLLAMA_HOST) from OLLAMA_URL ---
# so `ollama pull` inside pull-model.sh talks to the right daemon.
URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
HOSTPORT="${URL#*://}"      # strip scheme
HOSTPORT="${HOSTPORT%%/*}"  # strip any path
HOST="${HOSTPORT%%:*}"      # host without port
export OLLAMA_HOST="$HOSTPORT"

# --- Decide internal vs external ---
if [ -n "${OLLAMA_INTERNAL:-}" ]; then
  case "$OLLAMA_INTERNAL" in
    1|true|TRUE|yes) INTERNAL=1 ;;
    *) INTERNAL=0 ;;
  esac
elif [ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ] || [ "$HOST" = "::1" ]; then
  INTERNAL=1
else
  INTERNAL=0
fi

OLLAMA_PID=""
if [ "$INTERNAL" = "1" ]; then
  log "starting Ollama daemon inside container ($OLLAMA_HOST)"
  ollama serve &
  OLLAMA_PID=$!
else
  log "using EXTERNAL Ollama at $OLLAMA_URL — not starting a local daemon"
  log "(Apple Silicon: run 'OLLAMA_HOST=0.0.0.0:11434 ollama serve' natively on the host)"
fi

# --- Pull configured models (works for internal or external daemon) ---
MODELS=""
# shellcheck disable=SC2086
for m in "${DESCRIBER_MODEL:-}" "${DECISION_MODEL:-}" ${EXTRA_MODELS:-}; do
  [ -n "$m" ] || continue
  case " $MODELS " in
    *" $m "*) : ;;
    *) MODELS="$MODELS $m" ;;
  esac
done
if [ -n "$MODELS" ]; then
  log "ensuring models:$MODELS"
  # A pull failure must NOT stop startup — the service comes up either way and
  # you can re-pull with: docker compose exec bouncer pull-model.sh <tag>
  # shellcheck disable=SC2086
  /usr/local/bin/pull-model.sh $MODELS || log "one or more models failed to pull (continuing)"
else
  log "no DESCRIBER_MODEL / DECISION_MODEL set — skipping pre-pull"
fi

# --- Start Bouncer (Node service) ---
log "starting Bouncer on :${PORT:-8080}"
node /app/server.js &
NODE_PID=$!

# --- Babysit: if a managed process dies, stop the container ---
if [ -n "$OLLAMA_PID" ]; then
  wait -n "$OLLAMA_PID" "$NODE_PID"
else
  wait -n "$NODE_PID"
fi
EXIT=$?
log "a managed process exited (code $EXIT) — stopping container"
[ -n "$OLLAMA_PID" ] && kill "$OLLAMA_PID" 2>/dev/null
kill "$NODE_PID" 2>/dev/null
exit "$EXIT"
