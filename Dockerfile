# Single, self-contained image: Ollama + the Bouncer service in one container.
#
# Base is node:20-slim (Debian slim, glibc). We add Ollama's CPU build on top.
# NOTE: Alpine is intentionally NOT used — Ollama ships glibc-only binaries and
# does not support musl/Alpine. Debian slim keeps the image lean while staying
# on a supported libc, and we skip the GPU runtimes entirely (CPU-only server).
FROM node:20-slim

# Ollama (CPU) + OpenMP runtime it needs for CPU inference.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates libgomp1 zstd \
 && curl -fsSL https://ollama.com/install.sh | sh \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps first for layer caching (sharp ships prebuilt binaries).
COPY classifier/package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force

# Service code + demo UI + prompts.
COPY classifier/server.js ./server.js
COPY index.html styles.css app.js ./public/
COPY prompts ./prompts

# Startup + model-pull scripts.
COPY docker/pull-model.sh /usr/local/bin/pull-model.sh
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/pull-model.sh /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    PORT=8080 \
    OLLAMA_HOST=127.0.0.1:11434 \
    OLLAMA_URL=http://127.0.0.1:11434 \
    PROMPTS_DIR=/app/prompts \
    PUBLIC_DIR=/app/public

# Only Bouncer is exposed; Ollama stays on 127.0.0.1 inside the container.
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []
