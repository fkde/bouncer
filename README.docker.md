# Bouncer — Docker deployment

A self-contained image safety classifier: **Ollama + a Node API in ONE
container**. Send it an image, get back `{ allowed, reason, confidence }`.
Runs on **CPU** (no GPU required); see the GPU section for acceleration.

## What's in the box

```
Dockerfile            one image: node:20-slim + Ollama (CPU) + the service
docker-compose.yml    one service ("bouncer"), port 8080, models volume
docker/
  entrypoint.sh       starts Ollama (127.0.0.1 only) + pulls models + starts Node
  pull-model.sh       reusable model puller (also usable by hand)
classifier/server.js  the API: POST /classify + serves the demo UI
```

Inside the container, the Node service talks to Ollama on `127.0.0.1:11434`;
only port 8080 is published.

The classification is **two-stage** (unchanged from the original app, just moved
server-side):

1. **Describe** — a vision model turns the image into neutral text.
2. **Decide** — a text model returns `{ allowed, reason, confidence }` (JSON-schema enforced).

Confidence below the threshold → `uncertain` (flagged for review).

## Quick start

```bash
cp .env.example .env      # adjust models / port if you like
docker compose up --build
```

On first start the `ollama` container pulls `DESCRIBER_MODEL` and `DECISION_MODEL`
(this can take a few minutes). Then open the demo UI:

```
http://localhost:8080
```

## Configuration (`.env`)

| Variable          | Default       | Meaning |
|-------------------|---------------|---------|
| `DESCRIBER_MODEL` | `gemma4:e2b`  | Stage 1 vision model. **Must support images.** |
| `DECISION_MODEL`  | `gemma4:e2b`  | Stage 2 text model. Same tag as describer = fastest (one model in RAM). |
| `EXTRA_MODELS`    | –             | Space-separated extra tags to pre-pull at boot. |
| `THRESHOLD`       | `0.8`         | Below this confidence → `uncertain`. |
| `TEMPERATURE`     | `0`           | 0 = most deterministic. |
| `MAX_DIM`         | `1536`        | Images are downscaled to this longest edge. |
| `BOUNCER_PORT`    | `8080`        | Host port for the API + UI. |

## Hardware acceleration (GPU / Apple Silicon)

The default image is **CPU-only** (matches a GPU-less server). Acceleration
depends entirely on the host:

| Host | GPU in Docker? | How |
|------|----------------|-----|
| Linux + **NVIDIA** | ✅ yes | Needs the CUDA-enabled image + `nvidia-container-toolkit` on the host (see below). |
| **Apple Silicon** (M1–M4) | ❌ no | Docker runs a Linux VM with **no access to Metal**. Containers are always CPU here. For M-series acceleration, run Ollama **natively** on macOS and point the container at it. |
| Linux/Windows CPU server | n/a | This is the default — CPU only. |

**NVIDIA:** the slim default image does not bundle CUDA. Build the GPU variant
from the official Ollama base instead and pass the GPU through in compose:

```yaml
# docker-compose.override.yml (NVIDIA host)
services:
  bouncer:
    deploy:
      resources:
        reservations:
          devices:
            - { driver: nvidia, count: all, capabilities: [gpu] }
```

(Ask for `Dockerfile.gpu` — a 3-line variant on the `ollama/ollama` base — if you
have such a host.)

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
docker compose exec bouncer pull-model.sh gemma4:e4b
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
curl -s -F image=@/path/to/photo.jpg http://localhost:8080/classify
```

**JSON (base64):**

```bash
curl -s -X POST http://localhost:8080/classify \
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
`error`, any non-2xx status, or a request timeout — means **do not accept**.
Optional overrides (form fields or JSON keys): `describer`, `decision`,
`threshold`, `temperature`, `describerPrompt`, `decisionPrompt`.

### PHP / Guzzle

```php
$client = new \GuzzleHttp\Client(['base_uri' => 'http://classifier:8080']);

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

| Endpoint        | Purpose |
|-----------------|---------|
| `GET /api/health` | Is Ollama reachable? |
| `GET /api/models` | Installed models (with a `vision` flag) — used by the UI. |
| `GET /api/config` | Current defaults + prompts. |

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

- **CPU speed.** Around **~5 s per image** with a small model like `gemma4:e2b`
  (measured on Apple Silicon CPU); larger models are slower. The vision encode +
  generation dominate; the Node layer is negligible.
- **This is now a real enforcement point** — unlike the old browser-only tool,
  the models run server-side and callers can't bypass them. Ollama binds to
  `127.0.0.1` inside the container and is never published; only port 8080 is.
- **Not a substitute for review.** Confidence is self-reported by the model and
  imperfectly calibrated; treat `uncertain` as "needs a human", and consider a
  quick labelled eval set to tune `THRESHOLD` for your real images.
