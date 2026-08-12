# Bouncer 🛡️

**The doorman for your uploads.** A self-hosted service that checks whether an
uploaded image is safe to accept — primarily to keep **nudity / sexual content**
off your server. Runs a local LLM via **Ollama**, needs **no GPU**, and is a
single container.

Send it an image → get a verdict:

```json
{ "allowed": true, "block": false, "confidence": 0.94, "reason": "..." }
```

## How it works

Two stages, which is what makes small local models reliable here:

1. **Describe** — a vision model turns the image into neutral, factual text.
2. **Decide** — a text model reads that text and returns `{ allowed, reason, confidence }`.

Low confidence → `uncertain` (flag for review). Everything is **fail-closed**: on
any error, timeout, or overload the answer is "don't accept".

## Tags

| Tag | Build |
|-----|-------|
| `latest`, `X.Y.Z` | CPU-only, slim (~380 MB), amd64 + arm64. Runs anywhere. |
| `latest-gpu`, `X.Y.Z-gpu` | NVIDIA CUDA runners, amd64 only. Run with `--gpus all` + nvidia-container-toolkit. |

## Requirements

CPU-only is fine — **RAM is the constraint**. Rule of thumb: model download size
+ ~2 GB.

| Model (Ollama tag) | Vision | Download | RAM |
|--------------------|:------:|---------:|----:|
| `moondream`        | ✅ | 1.7 GB | ~4 GB |
| `qwen2.5vl:3b`     | ✅ | 3.2 GB | ~6 GB |
| `gemma3:4b`        | ✅ | 3.3 GB | ~6 GB |
| `llava:7b`         | ✅ | 4.7 GB | ~7 GB |
| **`gemma4:e2b`** (default) | ✅ | 7.2 GB | **~10 GB** |
| `gemma4:e4b`       | ✅ | 9.6 GB | ~12 GB |
| `gemma3:1b`        | ❌ | 0.8 GB | ~2 GB (decider only) |

Same tag for both stages = one model in RAM. Two different tags = add them up.
Plan ~20 GB of disk for the models volume.

## Quick start

```bash
docker run -d --name bouncer --restart unless-stopped \
  -p 8080:8080 -v bouncer-models:/root/.ollama \
  -e API_TOKEN="$(openssl rand -hex 32)" \
  -e DESCRIBER_MODEL=gemma4:e2b -e DECISION_MODEL=gemma4:e2b \
  fkde/bouncer:latest
```

- The `-v` volume persists pulled models across restarts.
- **First start pulls the model — 7 GB for the default, so 10–30 minutes.** The
  container reports `healthy` only once the download is done and it can classify
  — watch with `docker ps` (STATUS column) or `curl localhost:8080/healthz`.
- Then: demo UI on <http://localhost:8080>, API at `POST /classify`.
- **Set `API_TOKEN`.** Without it the endpoint is open to anyone who can reach the
  port, and this service is an upload gate.

## Using the API

```bash
# file upload
curl -s -H "Authorization: Bearer $TOKEN" -F image=@photo.jpg http://localhost:8080/classify

# or JSON base64
curl -s -X POST http://localhost:8080/classify \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"image_base64":"'"$(base64 -i photo.jpg)"'"}'
```

**Integrate fail-closed:** accept the upload only when `block === false`. Every
other case — `rejected`, `uncertain`, `error`, `401`, `503` (queue full → retry) —
means do not accept.

## Configuration (env vars)

| Variable | Default | Meaning |
|----------|---------|---------|
| `API_TOKEN` | *(empty)* | Bearer token for the API. Empty = **open**. |
| `ALLOW_OVERRIDES` | `false` | Let callers override models/prompts/threshold. Keep off — it can disable the gate. |
| `SERVE_UI` | `true` | Serve the demo UI at `/`. Set `false` for a pure API. |
| `DESCRIBER_MODEL` | `gemma4:e2b` | Stage 1 vision model (**must support images**). |
| `DECISION_MODEL` | `gemma4:e2b` | Stage 2 text model. Same tag = fastest. |
| `THRESHOLD` | `0.8` | Below this confidence → `uncertain`. |
| `TEMPERATURE` | `0` | 0 = most deterministic. |
| `MAX_DIM` | `1536` | Downscale longest edge before inference. |
| `CLASSIFY_CONCURRENCY` | `1` | Images processed at once (CPU: keep 1). |
| `QUEUE_MAX` | `32` | Active+waiting cap before `503` backpressure. |
| `OLLAMA_URL` | internal | Point at an external Ollama (e.g. a GPU host). |

Pull more models anytime:

```bash
docker exec bouncer pull-model.sh gemma4:e4b
```

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /classify` | Classify an image (multipart `image` or JSON `image_base64`). Token required. |
| `GET /healthz` | `200` once ready (models pulled), else `503`. Open — used by the healthcheck. |
| `GET /api/health` | Rich status: `ready`, model count, queue depth. Token required. |
| `GET /` | Demo UI (unless `SERVE_UI=false`). |

## GPU (NVIDIA)

Needs the `-gpu` tag *and* the host's nvidia-container-toolkit:

```bash
docker run -d --name bouncer --restart unless-stopped --gpus all \
  -p 8080:8080 -v bouncer-models:/root/.ollama \
  -e API_TOKEN="$TOKEN" \
  -e DESCRIBER_MODEL=gemma4:e2b -e DECISION_MODEL=gemma4:e2b \
  fkde/bouncer:latest-gpu
```

## Notes

- **Local only** — images and models stay on your machine; no cloud calls.
- **Not a substitute for human review** — model confidence is imperfectly
  calibrated; treat `uncertain` as "needs a look".
- Full docs & source: **https://github.com/fkde/bouncer**
