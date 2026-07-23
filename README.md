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

## Quick start

Requires Docker.

```bash
cp .env.example .env      # optional: pick models / port
docker compose up --build
```

First start pulls the model(s) (a few minutes), then:

- **Demo UI:** <http://localhost:8080>
- **API:** `POST http://localhost:8080/classify`

```bash
curl -s -F image=@photo.jpg http://localhost:8080/classify
```

## Integrating it

Any language can call the API — it's the enforcement point in front of your
uploads. Accept a file only when `block === false`:

```php
// PHP / Guzzle
$res = $client->post('/classify', ['multipart' => [
    ['name' => 'image', 'contents' => fopen($tmpPath, 'r'), 'filename' => 'upload.jpg'],
]]);
if (!empty(json_decode((string) $res->getBody(), true)['block'])) {
    // reject / quarantine
}
```

`block === true` means don't accept — covers `rejected`, `uncertain`, `error`,
timeouts, and `503` (queue full → retry). See **[README.docker.md](README.docker.md)**
for the full API, response fields, load/queue behaviour, and GPU / Apple Silicon
notes.

## Configuration

Set in `.env` (see [`.env.example`](.env.example)):

| Variable | Default | Meaning |
|----------|---------|---------|
| `DESCRIBER_MODEL` | `gemma4:e2b` | Stage 1 vision model (**must support images**). |
| `DECISION_MODEL`  | `gemma4:e2b` | Stage 2 text model. Same tag = fastest (one model in RAM). |
| `THRESHOLD` | `0.8` | Below this confidence → `uncertain`. |
| `CLASSIFY_CONCURRENCY` | `1` | Images processed at once (CPU: 1 = predictable). |
| `QUEUE_MAX` | `32` | Active+waiting cap before `503` backpressure. |
| `OLLAMA_URL` | in-container | Set to `http://host.docker.internal:11434` to use a native (e.g. Apple Silicon GPU) Ollama. |

Pull more models anytime — they appear in the UI immediately:

```bash
docker compose exec bouncer pull-model.sh gemma4:e4b
```

## Prompts

The two prompts are plain text files in [`prompts/`](prompts/) and are the source
of truth. They're read on every request, so edit and re-run — no rebuild.

## Project layout

```
Dockerfile              one image: node:20-slim + Ollama (CPU) + the service
docker-compose.yml      one service ("app"), port 8080
docker/                 entrypoint (runs Ollama + Node) + reusable pull-model.sh
classifier/server.js    the API: POST /classify, queue, serves the UI
index.html · app.js     the demo UI (a thin client for the API)
prompts/                describer.txt + decision.txt (editable)
README.docker.md        full deployment / API / ops reference
AGENTS.md               design notes & rationale for contributors
```

## Notes

- **Local only.** No cloud calls; images and models stay on your machine.
- **Not a substitute for human review.** Model confidence is imperfectly
  calibrated — treat `uncertain` as "needs a look", and tune `THRESHOLD` against a
  small labelled set of your own images.
- Ollama binds to `127.0.0.1` inside the container; only port 8080 is published.
