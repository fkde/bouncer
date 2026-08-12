#!/usr/bin/env sh
# pull-model.sh — ensure one or more Ollama models are available locally.
#
# Reusable on purpose:
#   * called at container boot by entrypoint.sh with DESCRIBER_MODEL / DECISION_MODEL
#   * callable by hand once the stack is up, e.g.:
#       docker compose exec bouncer pull-model.sh gemma4:e4b
#     to download a new model and make it selectable in the UI.
#
# Usage: pull-model.sh <identifier> [<identifier> ...]
# Identifiers are plain Ollama tags (e.g. gemma4:e2b, gemma4:e4b, llava:7b).
set -eu

log() { printf '[pull-model] %s\n' "$*" >&2; }

# The daemon may still be starting (at boot). Wait until it answers.
wait_for_ollama() {
  i=0
  until ollama list >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then
      log "Ollama daemon not reachable after 60s — aborting."
      return 1
    fi
    sleep 1
  done
}

# Already present? Skip — keeps restarts fast and the script idempotent.
has_model() {
  ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$1"
}

# "gemma4" -> "gemma4:latest". Ollama always reports tags fully qualified, so an
# unqualified name would never match and we'd re-pull on every single boot.
norm_tag() {
  case "$1" in
    *:*) printf '%s' "$1" ;;
    *) printf '%s:latest' "$1" ;;
  esac
}

pull_one() {
  id="$(norm_tag "$1")"
  [ -n "$id" ] || return 0
  if has_model "$id"; then
    log "already present: $id"
    return 0
  fi
  log "pulling: $id  (first time can take a while)"
  if ollama pull "$id"; then
    log "done: $id"
    return 0
  fi
  log "FAILED to pull: $id"
  return 1
}

if [ "$#" -eq 0 ]; then
  log "no model identifiers given"
  exit 0
fi

wait_for_ollama || exit 1

rc=0
for id in "$@"; do
  pull_one "$id" || rc=1
done
exit "$rc"
