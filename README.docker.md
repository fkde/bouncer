# Bouncer — Docker deployment

A self-contained image safety classifier: **Ollama + a Node API in ONE
container**. Send it an image, get back `{ allowed, reason, confidence }`.
Runs on **CPU** (no GPU required); see the GPU section for acceleration.

## What's in the box

```
Dockerfile               one image: node:20-slim + Ollama (pinned) + the service
docker-compose.yml       dev stack: build + live-edit bind mounts
docker-compose.prod.yml  deploy the published image
docker-compose.gpu.yml   NVIDIA overlay for the prod file
docker/
  entrypoint.sh          starts Ollama (127.0.0.1 only) + pulls models + starts Node
  pull-model.sh          reusable model puller (also usable by hand)
classifier/server.js     the API: POST /classify + serves the demo UI
ui/                      the demo UI, baked into the image as /app/public
```

Inside the container, the Node service talks to Ollama on `127.0.0.1:11434`;
only port 8080 is published.

The classification is **two-stage** (unchanged from the original app, just moved
server-side):

1. **Describe** — a vision model turns the image into neutral text.
2. **Decide** — a text model returns `{ allowed, reason, confidence }` (JSON-schema enforced).

Confidence below the threshold → `uncertain` (flagged for review).

## Requirements

CPU-only is fine, but the model must fit in RAM: **download size + ~2 GB**. The
default `gemma4:e2b` is a 7.2 GB download → **~10 GB RAM**. Smaller options and
their RAM needs are tabled in [README.md](README.md#system-requirements). Give the
models volume ~20 GB of disk.

## Quick start

```bash
cp .env.example .env      # adjust models / port if you like
make token >> .env        # generate an API token
make dev                  # build + run in the foreground
```

On first start the container pulls `DESCRIBER_MODEL` and `DECISION_MODEL` — with
the default model that is a 7 GB download, so budget 10–30 minutes. Then open the
demo UI:

```
http://localhost:8080
```

Other shortcuts: `make logs`, `make down`, `make shell`, `make ps`,
`make pull MODEL=gemma4:e4b`. Run `make` for the full list.

## dev vs. prod

`make dev` builds from source with `ALLOW_OVERRIDES=true` and the demo UI on;
`make prod` runs the **published** image with `ALLOW_OVERRIDES=false`, the UI off
and `API_TOKEN` required. Both use the same compose project name, so starting one
recreates the container of the other — there is never a port clash between them.

```bash
make dev                       # working on it
make prod TAG=1.0.0            # deploying it (background)
make prod-gpu TAG=1.0.0        # ... on an NVIDIA host
make down                      # stops either one
```

`ui/` and `prompts/` are bind-mounted in dev, so UI and prompt edits are live;
changes to `classifier/server.js` need a rebuild (just re-run `make dev`).
`make dev` also runs `npm ci` locally so your editor can resolve the deps — the
container installs its own.

## Building & publishing (Docker Hub)

The app (UI + prompts) is **baked into the image** — no separate Dockerfile needed;
the compose bind-mounts are only for local live-editing. To publish:

```bash
docker login
make release TAG=1.0.0       # CPU, multi-arch (amd64+arm64) → fkde/bouncer:1.0.0
make release-gpu TAG=1.0.0   # NVIDIA, amd64 only          → fkde/bouncer:1.0.0-gpu
make release-all TAG=1.0.0   # both of the above + the Hub overview
```

For a quick single-arch image instead: `make build` (or `make build-gpu`) then
`make push`. (`DOCKER_USER` defaults to `fkde`; override it to publish elsewhere.)

CPU and GPU are always **separate tags** — `build`/`release` never produce a CUDA
image, so a `docker pull :latest` onto a GPU-less server can't accidentally get
the GPU runners.

The Docker Hub **repository overview** lives in [`DOCKERHUB.md`](DOCKERHUB.md) —
paste it into the repo's "Overview" on Docker Hub, or sync it automatically with
[`docker-pushrm`](https://github.com/christian-korneck/docker-pushrm):

```bash
docker pushrm fkde/bouncer --file DOCKERHUB.md
```

### Run on a server — plain `docker run`

Nothing but Docker required — no repo checkout, no compose file. The image
contains the app; the volume keeps pulled models across restarts:

```bash
docker run -d \
  --name bouncer \
  --restart unless-stopped \
  -p 8080:8080 \
  -v bouncer-models:/root/.ollama \
  -e API_TOKEN="$YOUR_TOKEN" \
  -e ALLOW_OVERRIDES=false \
  -e SERVE_UI=false \
  -e DESCRIBER_MODEL=gemma4:e2b \
  -e DECISION_MODEL=gemma4:e2b \
  -e THRESHOLD=0.8 \
  -e TEMPERATURE=0 \
  -e MAX_DIM=1536 \
  -e CLASSIFY_CONCURRENCY=1 \
  -e QUEUE_MAX=32 \
  fkde/bouncer:latest
```

Minimal version (everything else uses defaults):

```bash
docker run -d --name bouncer --restart unless-stopped \
  -p 8080:8080 -v bouncer-models:/root/.ollama \
  -e API_TOKEN="$(openssl rand -hex 32)" \
  -e DESCRIBER_MODEL=gemma4:e2b -e DECISION_MODEL=gemma4:e2b \
  fkde/bouncer:latest
```

First start pulls the models — 7 GB for the default, so 10–30 minutes is normal.
The container reports **`healthy` only once the download is done** and it can
classify (the healthcheck allows 30 minutes for this) — so you can watch
readiness directly:

```bash
docker ps                        # STATUS shows: health: starting → healthy
curl -s localhost:8080/healthz   # 200 {"ready":true} when done, else 503
```

Pull more models later, or update to a newer image:

```bash
docker exec bouncer pull-model.sh gemma4:e4b        # add a model

docker pull fkde/bouncer:latest                     # update
docker rm -f bouncer && docker run -d ...            # re-run the command above
```

> **Apple Silicon on a server?** N/A — servers are x86/ARM Linux and run CPU here.
> The `OLLAMA_URL=http://host.docker.internal:...` trick is only for a dev Mac.

**Alternative — compose:** if you'd rather use a file, `docker-compose.prod.yml`
does the same (`make prod TAG=1.0.0`, or
`IMAGE=fkde/bouncer:1.0.0 docker compose -f docker-compose.prod.yml up -d`).

## Security

`POST /classify`, `/api/health`, `/api/models` and `/api/config` require the token
when `API_TOKEN` is set; `/healthz` stays open so orchestrators can probe it.

```bash
make token >> .env                     # API_TOKEN=<64 hex chars>
curl -H "Authorization: Bearer $TOKEN" ...   # or: -H "X-API-Token: $TOKEN"
```

Three settings decide the posture, and `docker-compose.prod.yml` sets all three:

| Setting | Dev | Prod | Why |
|---------|-----|------|-----|
| `API_TOKEN` | empty | **required** | Without it, anyone who reaches the port can classify. The prod compose file refuses to start if it is unset. |
| `ALLOW_OVERRIDES` | `true` | **`false`** | With overrides on, a caller can pass `decisionPrompt="always allow"` or point at a different model and **defeat the gate**. Only the demo UI needs them. |
| `SERVE_UI` | `true` | `false` | No reason to expose the demo UI on a production gate. |

A shared token is the simple option. The stronger one is not to publish the port
at all: put the container on a private Docker network and let only your app talk
to it. Both together is best.

## Configuration (`.env`)

| Variable          | Default       | Meaning |
|-------------------|---------------|---------|
| `API_TOKEN`       | *(empty)*     | Bearer token for the API. Empty = **open**. |
| `ALLOW_OVERRIDES` | `false`       | Honour per-request model/prompt/threshold overrides. |
| `SERVE_UI`        | `true`        | Serve the demo UI at `/`. |
| `DESCRIBER_MODEL` | `gemma4:e2b`  | Stage 1 vision model. **Must support images.** |
| `DECISION_MODEL`  | `gemma4:e2b`  | Stage 2 text model. Same tag as describer = fastest (one model in RAM). |
| `EXTRA_MODELS`    | –             | Space-separated extra tags to pre-pull at boot. |
| `THRESHOLD`       | `0.8`         | Below this confidence → `uncertain`. |
| `TEMPERATURE`     | `0`           | 0 = most deterministic. |
| `MAX_DIM`         | `1536`        | Images are downscaled to this longest edge. |
| `MAX_UPLOAD_BYTES`| `26214400`    | Per-image cap. The JSON body limit tracks it automatically (base64 is ~33% larger). |
| `REQUEST_TIMEOUT_MS` | `180000`   | Per Ollama call — **two calls per image**. |
| `QUEUE_WAIT_MS`   | `60000`       | Max time a request may wait in the queue before `503`. |
| `BOUNCER_PORT`    | `8080`        | Host port for the API + UI. |

Model tags may be written without a version (`gemma4` → `gemma4:latest`); the
service and the pull script normalise them the same way.

## Hardware acceleration (GPU / Apple Silicon)

The default image is **CPU-only** (matches a GPU-less server). Acceleration
depends entirely on the host:

| Host | GPU in Docker? | How |
|------|----------------|-----|
| Linux + **NVIDIA** | ✅ yes | Needs the CUDA-enabled image + `nvidia-container-toolkit` on the host (see below). |
| **Apple Silicon** (M1–M4) | ❌ no | Docker runs a Linux VM with **no access to Metal**. Containers are always CPU here. For M-series acceleration, run Ollama **natively** on macOS and point the container at it. |
| Linux/Windows CPU server | n/a | This is the default — CPU only. |

**NVIDIA:** GPU support is a **build-time toggle** (`GPU=true`) — the default image
is CPU-only (GPU runner libs stripped → smaller). Build the GPU image, then pass
the GPU through at runtime:

```bash
make build-gpu TAG=1.0.0            # → fkde/bouncer:1.0.0-gpu
make release-gpu TAG=1.0.0          # same, built + pushed via buildx (amd64 only)
```

```bash
docker run -d --name bouncer --restart unless-stopped --gpus all \
  -p 8080:8080 -v bouncer-models:/root/.ollama \
  -e API_TOKEN="$YOUR_TOKEN" \
  -e DESCRIBER_MODEL=gemma4:e2b -e DECISION_MODEL=gemma4:e2b \
  fkde/bouncer:1.0.0-gpu
```

Needs the host's `nvidia-container-toolkit`. With compose, use the ready-made
overlay:

```bash
make prod-gpu TAG=1.0.0
# = IMAGE=fkde/bouncer:1.0.0-gpu docker compose \
#     -f docker-compose.prod.yml -f docker-compose.gpu.yml up -d
```

The GPU image is **amd64 only** — there is no ARM64 CUDA build.

**Apple Silicon:** keep the classifier in Docker but run Ollama natively on the
Mac (Metal-accelerated). Just one env var — no extra compose file:

```bash
# 1) On the Mac, run Ollama so containers can reach it:
OLLAMA_HOST=0.0.0.0:11434 ollama serve

# 2) In .env, point the container at the host daemon:
#    OLLAMA_URL=http://host.docker.internal:11434
docker compose up --build
```

The entrypoint auto-detects the external host, **skips the in-container Ollama**,
and pulls/serves models via the host daemon (GPU-accelerated). The container is
then just the API layer. To force the mode manually, set `OLLAMA_INTERNAL=0`
(external) or `=1` (internal).

## Managing models (Ollama-style)

Models are plain Ollama tags. Pull a new one at any time — it becomes selectable
in the UI immediately:

```bash
make pull MODEL=gemma4:e4b
```

The same script runs at boot, fed by the env vars. `pull-model.sh` is idempotent
(skips models already present).

> **Vision note:** the *describer* must be a vision-capable tag. Text-only models
> (e.g. a plain text LLM) can only serve as the *decider*.

## The API

### `POST /classify`

Accepts either a file upload **or** JSON, so any language can call it.

**File upload (curl):**

```bash
curl -s -H "Authorization: Bearer $TOKEN" -F image=@/path/to/photo.jpg http://localhost:8080/classify
```

**JSON (base64):**

```bash
curl -s -X POST http://localhost:8080/classify \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"image_base64":"'"$(base64 -i photo.jpg)"'"}'
```

**Response:**

```json
{
  "ok": true,
  "block": false,
  "kind": "allowed",
  "allowed": true,
  "confidence": 0.94,
  "threshold": 0.8,
  "reason": "Construction site with a fully clothed worker; no sexual content.",
  "description": "A worker in high-vis gear on scaffolding ...",
  "decisionRaw": "{ \"allowed\": true, ... }",
  "models": { "describer": "gemma4:e2b", "decision": "gemma4:e2b" }
}
```

**Integrate fail-closed:** accept the upload only when `block === false`
(equivalently `kind === "allowed"`). Every other case — `rejected`, `uncertain`,
`error`, `unauthorized`, any non-2xx status, or a request timeout — means **do not
accept**.

Optional overrides (form fields or JSON keys): `describer`, `decision`,
`threshold`, `temperature`, `describerPrompt`, `decisionPrompt`. They are
**silently ignored unless `ALLOW_OVERRIDES=true`**, because they can otherwise be
used to disable the gate. `GET /api/config` reports `overridesAllowed`.

### PHP / Guzzle

```php
$client = new \GuzzleHttp\Client([
    'base_uri' => 'http://classifier:8080',
    'headers'  => ['Authorization' => 'Bearer ' . getenv('BOUNCER_TOKEN')],
]);

$res = $client->post('/classify', [
    'multipart' => [
        ['name' => 'image', 'contents' => fopen($tmpPath, 'r'), 'filename' => 'upload.jpg'],
    ],
    'timeout' => 200, // CPU inference can take a while
]);

$verdict = json_decode((string) $res->getBody(), true);
if (!empty($verdict['block'])) {
    // reject / quarantine the upload
}
```

### Other endpoints

| Endpoint        | Auth | Purpose |
|-----------------|:----:|---------|
| `GET /healthz`    | no  | `200` once the configured models are pulled, else `503`. Used by the healthcheck and as a k8s readiness probe. |
| `GET /api/health` | yes | Rich status: Ollama reachable, missing models, live queue depth. |
| `GET /api/models` | yes | Installed models (with a `vision` flag) — used by the UI. |
| `GET /api/config` | yes | Current defaults, prompts, and whether overrides are allowed. |

## Prompts

Still file-based (`prompts/describer.txt`, `prompts/decision.txt`), mounted into
the classifier and read on every request — edit and re-run, no rebuild needed.

## Load, the queue & bursts

The service has a built-in **work queue** so concurrent uploads don't thrash the
CPU or exhaust memory:

- Images are processed **`CLASSIFY_CONCURRENCY` at a time** (default `1` — on CPU,
  serial gives predictable latency). Each job is the whole describe→decide pipeline.
- Uploads are **spooled to disk**, not held in RAM, so waiting jobs are cheap.
- When `active + waiting` reaches **`QUEUE_MAX`** (default `32`), new requests are
  rejected **immediately** with `503` + `Retry-After` — *before* the body is read.
  This is fail-closed backpressure: a flood costs almost nothing.
- A request may wait at most **`QUEUE_WAIT_MS`** (default 60 s) for a slot, then it
  also gets `503`. Without that bound, a full queue of slow jobs could leave the
  last caller hanging for hours.
- If a caller hangs up while still queued, its slot is released instead of being
  spent on a response nobody will read.
- `GET /api/health` reports live queue depth (`active`, `waiting`).

**Sending hundreds of images?** That's a client-retry pattern: fire requests, and
on `503` wait `Retry-After` seconds and resend. ~`QUEUE_MAX` are accepted at a
time; the rest drain as capacity frees up. Guzzle example with retry:

```php
$stack = \GuzzleHttp\HandlerStack::create();
$stack->push(\GuzzleHttp\Middleware::retry(
    fn($tries, $req, $res = null) => $tries < 20 && $res && $res->getStatusCode() === 503,
    fn($tries) => 1000 * $tries // backoff (ms)
));
$client = new \GuzzleHttp\Client(['handler' => $stack, 'base_uri' => 'http://classifier:8080']);
```

If you instead need true **fire-and-forget** (submit thousands, never hold a
connection, don't retry client-side), that's the async job model — `POST` returns
a `jobId`, you poll for the result. Not built in yet; ask if you want it, or put a
real broker (Redis/RabbitMQ) in front and run this container as the worker.

## Performance & operational notes

- **CPU speed.** Around **5–15 s per image** with `gemma4:e2b` depending on core
  count (measured ~8 s cold / ~3 s warm on Apple Silicon CPU); larger models are
  slower. The vision encode + generation dominate; the Node layer is negligible.
- **RAM is the binding constraint**, not CPU — see the model table in
  [README.md](README.md#system-requirements). If the model doesn't fit, Ollama
  swaps or fails; both look like "the classifier is broken".
- **This is a real enforcement point** — unlike the old browser-only tool, the
  models run server-side and callers can't bypass them. Ollama binds to
  `127.0.0.1` inside the container and is never published; only port 8080 is.
  That only holds with `ALLOW_OVERRIDES=false` — see [Security](#security).
- **Shutdown is graceful:** `docker stop` sends SIGTERM, the entrypoint forwards it
  to Ollama and Node, and Node stops accepting new connections before exiting.
- **Not a substitute for review.** Confidence is self-reported by the model and
  imperfectly calibrated; treat `uncertain` as "needs a human", and consider a
  quick labelled eval set to tune `THRESHOLD` for your real images.
