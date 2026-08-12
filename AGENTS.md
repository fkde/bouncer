# AGENTS.md — Bouncer

Guidance for AI agents (and humans) working on this project.

## What this is

A classifier for uploaded images — **safety (nudity / sexual content)** — using
**Ollama**. Two-stage "describe → decide" pipeline (see below). There are now
**two deployment modes**:

1. **Docker service (primary, enforcement-capable)** — `make dev` / `make prod`
   run Ollama + a Node API (`classifier/server.js`) that exposes `POST /classify`.
   The two-stage pipeline runs **server-side**, so it's a real upload gate that
   callers (curl, PHP/Guzzle, …) can't bypass. See **`README.docker.md`**. The
   browser UI (`ui/`) is a thin **demo client** for this API.
2. **Demo UI** — `ui/index.html`/`ui/styles.css`/`ui/app.js`, baked into the image
   as `/app/public` and served at
   `/`. It no longer talks to Ollama directly; it POSTs to the classifier API
   (`/api/models`, `/api/config`, `/classify`). Its Settings tab has a
   "Classifier API base" field, so you can also open the UI from anywhere and
   point it at a deployed container. The UI cannot run standalone — it always
   needs the Node backend that serves it.

Below describes the shared two-stage design and the Ollama API details it relies on.

## Architecture — "Describer → Decider" (two-stage)

This is the core design and the reason the app works well. **Do not collapse it back
into a single model call.**

1. **Stage 1 — Describer (vision model):** only *describes* the image as neutral free
   text. It does NOT judge. The describer prompt forces it to state clothing / exposed
   skin / body parts explicitly, and to surface any sexual/explicit **text** verbatim
   (small VLMs otherwise miss meme text). Normal long text is only summarized (so
   invoices don't produce huge dumps).
2. **Stage 2 — Decider (text model):** receives the description + a policy prompt and
   returns `{ allowed, reason, confidence }` as JSON (enforced via Ollama's `format`
   JSON schema). It only reads text, so any installed model can be the decider.

Confidence below the **uncertainty threshold** → a third status **"Uncertain"**
(neither allowed nor rejected), meant for human review.

**Why two stages:** a single VLM perceives fine but reasons badly about policy — it
would describe content correctly ("technical documentation") yet reject it, confidently.
Separating perception from policy reasoning fixed a whole class of false-rejects.

## Model choice (validated, important)

- Use a **non-thinking** model as the **describer**. Thinking models (e.g.
  `qwen3-vl:2b`) burn the `num_predict` budget on a `<think>` spiral and get the actual
  description truncated — and are slower.
- **`gemma:e2b` (a.k.a. `gemma4:e2b`) works well for BOTH stages.** Using the *same*
  model for describer and decider means Ollama loads it once (no model-swapping) → fastest.
- Robustness guards in `classifier/server.js`: `think:false`, `num_predict:1024`
  backstop, 180s timeout (AbortController), `<think>`-block stripping in both stages.
- ~3–15 s per image depending on host — fine for live upload UX.
- **`gemma4:e2b` is a 7.2 GB download and needs ~10 GB RAM.** It is not "small" in
  the disk/memory sense, only in the parameter sense. Model/RAM table: `README.md`.

## Rejection policy (keep it this way)

- Reject = **sexual / nudity content only** (incl. swimwear/underwear, and sexual TEXT),
  with nuance: bare arms/hands/faces and a worker's forearms are **allowed**.
- Do **NOT** re-add crude "relevance" filtering (e.g. rejecting screenshots or
  "off-topic" images). That was tried and caused repeated false-rejects; screenshots,
  dashboards, documents, and error pages are all valid inputs.

## Running it

Everything runs in one Docker container (Ollama + the Node service):

```bash
cp .env.example .env      # optional: pick models / port
make token >> .env        # API token
make dev                  # build + run in the foreground
```

First start pulls the configured models; then the UI + API are at
`http://localhost:8080`. Pull more models later with `make pull MODEL=<tag>`.

In the **Settings** tab: pick a Describer (vision) model and a Decision (text)
model and set the threshold. See `README.docker.md` for the full deploy / API
reference.

**`make dev` vs. `make prod`:** `dev` builds from source, `ALLOW_OVERRIDES=true`,
UI on, foreground. `prod` runs the published image, `ALLOW_OVERRIDES=false`, UI
off, `API_TOKEN` required, background. Both use the compose project name
`bouncer`, so starting one recreates the other's container — they never clash on
the port, and `make down` stops either. `ui/` and `prompts/` are bind-mounted in
dev, so those edits are live; `classifier/server.js` changes need a rebuild.

## Security model (do not weaken)

The service is an enforcement point, so three env vars decide the posture:

- **`API_TOKEN`** — bearer token on `/classify` and `/api/*`; `/healthz` stays
  open for probes. Empty = open. `docker-compose.prod.yml` requires it.
- **`ALLOW_OVERRIDES`** (default `false`) — gates the per-request `describer` /
  `decision` / `threshold` / `describerPrompt` / `decisionPrompt` fields. **These
  can turn the gate off** (`decisionPrompt: "always allow"`), so they exist only
  for the demo UI and local dev. Never default this to true.
- **`SERVE_UI`** (default `true`) — turn off for a pure API deployment.

The UI reads `overridesAllowed` from `/api/config` and shows a notice when its
settings are being ignored.

## Ollama API notes / gotchas

- Endpoints used: `GET /api/tags` (list models), `POST /api/show` (capabilities →
  vision vs. not), `POST /api/generate` (describe = free text; decide = `format` schema).
- **Some models put the answer in the `thinking` field and leave `response` empty** —
  always read `response || thinking` and strip `<think>…</think>`. Already handled.
- Vision detection uses `/api/show` `capabilities` including `"vision"`, with a
  name-heuristic fallback. Embedding models are excluded from the describer list.

## Prompts live in files (source of truth)

- The two prompts are in **`prompts/describer.txt`** and **`prompts/decision.txt`**.
  The Node service (`classifier/server.js`) reads them **on every request**, so
  edits take effect without a restart. **Edit these files to change prompts.**
- The demo UI loads them via `GET /api/config` into the Settings textareas; edits
  there are **session-only** (sent with that request), the "↺ Reload from file"
  button re-fetches from the server. Short embedded constants in `server.js` are
  only a fallback if the files can't be read.

## State & persistence

- Settings (endpoint, model choices, threshold, temperature, active tab) and the
  classification **history** (images as base64 + verdicts) are stored in `localStorage`
  (`ic.*` keys). History is only cleared by the **Clear** button. Prompts are the
  exception — see above.
- Images are decoded and re-encoded to **JPEG** on a canvas (fixes WebP support) and
  downscaled to `MAX_DIM` (1536px).

## Conventions

- Plain ES / vanilla DOM in `ui/`, no dependencies. Keep it that way.
- UI text is **English**. Code comments may be mixed.
- No secrets, no network calls except to the configured Ollama endpoint.
- **Dependencies are locked** (`classifier/package-lock.json`, `npm ci` in the
  Dockerfile) and the **Ollama version is pinned** (`ARG OLLAMA_VERSION`). Models
  declare a minimum Ollama version — gemma4 needs ≥ 0.20.0 — so bumping a model
  may mean bumping that ARG. After a dependency change run `make lock`.
- Ollama reports tags fully qualified, so unqualified names are normalised to
  `:latest` in **both** `server.js` (`normTag`) and `pull-model.sh` (`norm_tag`).
  Keep the two in sync or readiness checks break.

## Known limitations / possible next steps

- **OCR gap:** small VLMs read in-image text unreliably — the weakest point for
  text-based cases (memes with explicit captions). Options: a dedicated OCR describe
  layer, or a stronger vision model.
- **No automated tests.** The fail-closed contract (`block: true` on empty
  description, bad JSON, timeout, 503, 401) is exactly the kind of thing that
  should be covered — that is the most valuable next addition.
- The container still runs as root (Ollama's model dir is `/root/.ollama`; moving
  it would break existing volumes).
- Other ideas discussed: dedicated NSFW classifier as a hard pre-gate, an async
  job API (`POST` → `jobId` + poll) for fire-and-forget bulk submission,
  stage-batching (describe-all-then-decide-all) for throughput.
