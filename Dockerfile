# Single, self-contained image: Ollama + the Bouncer service in one container.
#
# Base is node:20-slim (Debian slim, glibc). We add Ollama's CPU build on top.
# NOTE: Alpine is intentionally NOT used — Ollama ships glibc-only binaries and
# does not support musl/Alpine. Debian slim keeps the image lean while staying
# on a supported libc, and we skip the GPU runtimes entirely (CPU-only server).
FROM node:20-slim

# GPU support is opt-in at build time:
#   GPU=false (default) → strip Ollama's bundled CUDA/ROCm runner libs → small,
#                         CPU-only image.
#   GPU=true            → keep them, for an NVIDIA host (run with `--gpus all`
#                         + nvidia-container-toolkit). Larger image.
# Toggle: docker build --build-arg GPU=true ...   (or `make build GPU=true`)
ARG GPU=false

# Pinned on purpose: an unpinned `curl | sh` makes two builds of the same tag
# differ, and models declare a MINIMUM Ollama version (gemma4 needs >= 0.20.0) —
# an older daemon fails the pull at runtime, not at build time.
ARG OLLAMA_VERSION=0.32.5

# Ollama + OpenMP runtime it needs for CPU inference.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates libgomp1 zstd \
 && curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION="$OLLAMA_VERSION" sh \
 && if [ "$GPU" != "true" ]; then \
      echo "CPU-only build: removing bundled GPU runner libs"; \
      for d in /usr/local/lib/ollama /usr/lib/ollama; do \
        if [ -d "$d" ]; then \
          find "$d" -maxdepth 1 \( -iname '*cuda*' -o -iname '*rocm*' -o -iname '*hip*' -o -iname '*cublas*' \) -exec rm -rf {} + || true; \
        fi; \
      done; \
    fi \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps first for layer caching (sharp ships prebuilt binaries).
# `npm ci` + the committed lockfile => the same tree on every build.
COPY classifier/package.json classifier/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Service code + demo UI + prompts.
COPY classifier/server.js ./server.js
COPY ui ./public
COPY prompts ./prompts

# Startup + model-pull scripts.
COPY docker/pull-model.sh /usr/local/bin/pull-model.sh
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/pull-model.sh /usr/local/bin/entrypoint.sh

ARG VERSION=dev
LABEL org.opencontainers.image.title="Bouncer" \
      org.opencontainers.image.description="Two-stage image safety gate (nudity/sexual content) — Ollama, CPU, one container." \
      org.opencontainers.image.source="https://github.com/fkde/bouncer" \
      org.opencontainers.image.url="https://github.com/fkde/bouncer" \
      org.opencontainers.image.version="${VERSION}"

ENV NODE_ENV=production \
    PORT=8080 \
    OLLAMA_HOST=127.0.0.1:11434 \
    OLLAMA_URL=http://127.0.0.1:11434 \
    PROMPTS_DIR=/app/prompts \
    PUBLIC_DIR=/app/public \
    ALLOW_OVERRIDES=false

# Only Bouncer is exposed; Ollama stays on 127.0.0.1 inside the container.
EXPOSE 8080

# "healthy" == the configured models are pulled and the service can classify.
# start-period covers the first model download without flapping — the default
# model is a ~7 GB pull, so this is 30 min, not 10.
HEALTHCHECK --interval=30s --timeout=5s --start-period=1800s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Docker sends SIGTERM to PID 1; the entrypoint forwards it to Ollama + Node.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []
