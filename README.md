# Bouncer

*The doorman for your uploads.*

A small, self-hosted service that checks whether an uploaded image is **safe to
accept** — primarily to keep **nudity / sexual content** off a server. It runs a
local LLM via **Ollama**, needs **no GPU**, and ships as **one Docker container**.

Send it an image, get back a verdict:

```json
{ "allowed": true, "block": false, "confidence": 0.94, "reason": "Construction site, fully clothed worker; no sexual content." }
```

## How it works — two stages

The trick that makes small local models reliable here is splitting perception from
policy:

1. **Describe** — a vision model turns the image into neutral, factual text
   (what's in it, what people wear, any explicit visible text).
2. **Decide** — a text model reads only that description and returns
   `{ allowed, reason, confidence }` (shape enforced by a JSON schema).

Confidence below a threshold becomes **`uncertain`** — flagged for a human rather
than silently allowed. Everything is **fail-closed**: on any error, timeout, or
overload the answer is "don't accept".

## System requirements

No GPU required, but **the model has to fit in RAM** — that is the real
constraint. Rule of thumb: **model download size + ~2 GB** for the runtime, KV
cache and the vision encoder.

| Model (Ollama tag) | Vision | Download | RAM needed | Notes |
|--------------------|:------:|---------:|-----------:|-------|
| `moondream`        | ✅ | 1.7 GB | ~4 GB  | Smallest option; weak at reading text in images. |
| `qwen2.5vl:3b`     | ✅ | 3.2 GB | ~6 GB  | Good size/quality compromise. |
| `gemma3:4b`        | ✅ | 3.3 GB | ~6 GB  | Solid all-rounder. |
| `llava:7b`         | ✅ | 4.7 GB | ~7 GB  | Older, well understood. |
| **`gemma4:e2b`**   | ✅ | 7.2 GB | **~10 GB** | **Default** — validated for both stages. |
| `gemma4:e4b`       | ✅ | 9.6 GB | ~12 GB | Better, noticeably slower on CPU. |
| `gemma3:1b`        | ❌ | 0.8 GB | ~2 GB  | Text only → usable as the *decider* alone. |

- **Disk:** the image itself is ~380 MB; add the model sizes above. Give the
  `ollama-models` volume 20 GB of headroom.
- **CPU:** any x86-64 or ARM64. Expect **~5–15 s per image** depending on model
  and core count. Cold start includes the model download.
- **Using the same tag for both stages is the fast path** — Ollama then keeps one
  model resident instead of swapping. Two *different* tags means both sit in RAM,
  so add the two numbers together.
- Below ~6 GB RAM, use `moondream` as describer and `gemma3:1b` as decider.

## Quick start

Requires Docker.

```bash
cp .env.example .env
make token >> .env        # generate an API token
make dev
```

First start pulls the model(s) — with the default that's a **7 GB download**, so
expect 10–30 minutes on the first run. Then:

- **Demo UI:** <http://localhost:8080> (paste the token into Settings)
- **API:** `POST http://localhost:8080/classify`

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" -F image=@photo.jpg http://localhost:8080/classify
```

## The two ways to run it

Both run in Docker on the same port and share the same compose project, so
starting one **replaces** the other — they never fight over port 8080.

| | `make dev` | `make prod` |
|---|---|---|
| Image | built from source | published (`fkde/bouncer:$TAG`) |
| `ALLOW_OVERRIDES` | `true` — UI's model/prompt controls work | `false` — the gate can't be talked out of it |
| Demo UI | on | off |
| `API_TOKEN` | optional | **required**, refuses to start without |
| Runs | foreground (Ctrl+C) | background |
| `ui/` + `prompts/` | bind-mounted, edits are live | baked into the image |

`make dev` also installs the Node dependencies locally — not for running, but so
your editor can resolve them.

Everything else works for both: `make logs`, `make ps`, `make down`,
`make shell`, `make pull MODEL=…`. Run `make` for the full list, and use
`BOUNCER_PORT=9090 make dev` if 8080 is taken.

## Security

The service is an **enforcement point**, so treat it like one:

- **`API_TOKEN`** — a shared secret sent as `Authorization: Bearer <token>`.
  Generate one with `make token` (32 random bytes, hex). Without it the endpoint
  is open to anyone who can reach the port; `docker-compose.prod.yml` refuses to
  start unless it is set. Even better than a token: don't publish the port at all
  and reach the container over a private Docker network from your app.
- **`ALLOW_OVERRIDES=false`** (production default) — otherwise callers may send
  their own models, thresholds and prompts, which lets them turn the gate off.
- **`SERVE_UI=false`** for a pure API deployment.
- Ollama binds to `127.0.0.1` inside the container and is never published.

## Integrating it

Any language can call the API — it's the enforcement point in front of your
uploads. Accept a file only when `block === false`:

```php
// PHP / Guzzle
$res = $client->post('/classify', [
    'headers'   => ['Authorization' => 'Bearer ' . getenv('BOUNCER_TOKEN')],
    'multipart' => [
        ['name' => 'image', 'contents' => fopen($tmpPath, 'r'), 'filename' => 'upload.jpg'],
    ],
]);
if (!empty(json_decode((string) $res->getBody(), true)['block'])) {
    // reject / quarantine
}
```

`block === true` means don't accept — covers `rejected`, `uncertain`, `error`,
timeouts, `401`, and `503` (queue full → retry). See
**[README.docker.md](README.docker.md)** for the full API, response fields,
load/queue behaviour, and GPU / Apple Silicon notes.

## Configuration

Set in `.env` (see [`.env.example`](.env.example)):

| Variable | Default | Meaning |
|----------|---------|---------|
| `API_TOKEN` | *(empty)* | Bearer token for the API. Empty = open. |
| `ALLOW_OVERRIDES` | `false` | Honour per-request model/prompt/threshold overrides. |
| `SERVE_UI` | `true` | Serve the bundled demo UI at `/`. |
| `DESCRIBER_MODEL` | `gemma4:e2b` | Stage 1 vision model (**must support images**). |
| `DECISION_MODEL`  | `gemma4:e2b` | Stage 2 text model. Same tag = fastest (one model in RAM). |
| `THRESHOLD` | `0.8` | Below this confidence → `uncertain`. |
| `CLASSIFY_CONCURRENCY` | `1` | Images processed at once (CPU: 1 = predictable). |
| `QUEUE_MAX` | `32` | Active+waiting cap before `503` backpressure. |
| `QUEUE_WAIT_MS` | `60000` | Max time a request may wait in the queue before `503`. |
| `OLLAMA_URL` | in-container | Set to `http://host.docker.internal:11434` to use a native (e.g. Apple Silicon GPU) Ollama. |

Pull more models anytime — they appear in the UI immediately:

```bash
make pull MODEL=gemma4:e4b
```

## Deploy on a server

Only Docker needed — no repo, no compose file. The app is baked into the image:

```bash
docker run -d --name bouncer --restart unless-stopped \
  -p 8080:8080 -v bouncer-models:/root/.ollama \
  -e API_TOKEN=$YOUR_TOKEN -e ALLOW_OVERRIDES=false -e SERVE_UI=false \
  -e DESCRIBER_MODEL=gemma4:e2b -e DECISION_MODEL=gemma4:e2b \
  fkde/bouncer:latest
```

The `-v` volume keeps pulled models across restarts. Full env-var list and update
steps in [README.docker.md](README.docker.md#run-on-a-server--plain-docker-run).

## Prompts

The two prompts are plain text files in [`prompts/`](prompts/) and are the source
of truth. They're read on every request, so edit and re-run — no rebuild.

## Project layout

```
Dockerfile               one image: node:20-slim + Ollama (pinned) + the app baked in
docker-compose.yml       dev: build + live-edit bind mounts, service "bouncer"
docker-compose.prod.yml  deploy: run the published Docker Hub image (no build)
docker-compose.gpu.yml   NVIDIA overlay for the prod file
Makefile                 make dev / prod / token / logs / build / release …
classifier/              the API: server.js + package.json + package-lock.json
docker/                  entrypoint (runs Ollama + Node) + reusable pull-model.sh
ui/                      the demo UI (index.html, app.js, styles.css)
prompts/                 describer.txt + decision.txt (editable, read per request)
README.docker.md         full deployment / API / ops reference
DOCKERHUB.md             overview text for the Docker Hub repository page
AGENTS.md                design notes & rationale for contributors
```

## Notes

- **Local only.** No cloud calls; images and models stay on your machine.
- **Not a substitute for human review.** Model confidence is imperfectly
  calibrated — treat `uncertain` as "needs a look", and tune `THRESHOLD` against a
  small labelled set of your own images.
