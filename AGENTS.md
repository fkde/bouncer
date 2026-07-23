# AGENTS.md — Bouncer

Guidance for AI agents (and humans) working on this project.

## What this is

A classifier for uploaded images — **safety (nudity / sexual content)** — using
**Ollama**. Two-stage "describe → decide" pipeline (see below). There are now
**two deployment modes**:

1. **Docker service (primary, enforcement-capable)** — `docker compose up` runs
   Ollama + a Node API (`classifier/server.js`) that exposes `POST /classify`.
   The two-stage pipeline runs **server-side**, so it's a real upload gate that
   callers (curl, PHP/Guzzle, …) can't bypass. See **`README.docker.md`**. The
   browser UI (`index.html`/`app.js`) is a thin **demo client** for this API.
2. **Demo UI** — `index.html`/`styles.css`/`app.js`, served by the classifier at
   `/`. It no longer talks to Ollama directly; it POSTs to the classifier API
   (`/api/models`, `/api/config`, `/classify`). Its Settings tab has a
   "Classifier API base" field, so you can also open the UI from anywhere and
   point it at a deployed container. (The old `make start` + direct-Ollama flow
   is superseded — the static files now need the Node backend behind them.)

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
- Robustness guards in `app.js`: `think:false`, `num_predict:1024` backstop, 180s
  timeout (AbortController), and `<think>`-block stripping in both stages.
- ~3–5 s per image — fine for live upload UX.

## Rejection policy (keep it this way)

- Reject = **sexual / nudity content only** (incl. swimwear/underwear, and sexual TEXT),
  with nuance: bare arms/hands/faces and a worker's forearms are **allowed**.
- Do **NOT** re-add crude "relevance" filtering (e.g. rejecting screenshots or
  "off-topic" images). That was tried and caused repeated false-rejects; screenshots,
  dashboards, documents, and error pages are all valid inputs.

## Running it

Ollama must run with CORS allowed for the browser origin:

```bash
launchctl setenv OLLAMA_ORIGINS "*"   # macOS app; then restart Ollama
# or: OLLAMA_ORIGINS='*' ollama serve
```

Serve the static files (see `Makefile`):

```bash
make start          # serves on http://localhost:8000 and opens the browser
make ollama-cors    # sets OLLAMA_ORIGINS for localhost:8000
```

Then in the **Settings** tab: pick a Describer (vision) model and a Decision (text)
model, set the threshold, and click the **↺ Default** buttons if prompts look stale.

## Ollama API notes / gotchas

- Endpoints used: `GET /api/tags` (list models), `POST /api/show` (capabilities →
  vision vs. not), `POST /api/generate` (describe = free text; decide = `format` schema).
- **Some models put the answer in the `thinking` field and leave `response` empty** —
  always read `response || thinking` and strip `<think>…</think>`. Already handled.
- Vision detection uses `/api/show` `capabilities` including `"vision"`, with a
  name-heuristic fallback. Embedding models are excluded from the describer list.

## Prompts live in files (source of truth)

- The two prompts are in **`prompts/describer.txt`** and **`prompts/decision.txt`**.
  `app.js` fetches them at startup (`loadPrompts()`) and fills the Settings textareas.
  **Edit these files to change prompts permanently.**
- Prompts are deliberately **NOT** stored in localStorage (that caused stale prompts
  before). Textarea edits are **session-only**; the "↺ Reload from file" button re-reads
  the file. Embedded constants (`DESCRIBER_PROMPT`, `DEFAULT_PROMPT`) are only a fallback
  when files can't be fetched (e.g. opening via `file://` instead of a web server).
- Because of the `fetch()`, the app must be served over HTTP (`make start`), not opened
  as a `file://` URL.

## State & persistence

- Settings (endpoint, model choices, threshold, temperature, active tab) and the
  classification **history** (images as base64 + verdicts) are stored in `localStorage`
  (`ic.*` keys). History is only cleared by the **Clear** button. Prompts are the
  exception — see above.
- Images are decoded and re-encoded to **JPEG** on a canvas (fixes WebP support) and
  downscaled to `MAX_DIM` (1536px).

## Conventions

- Plain ES / vanilla DOM, no dependencies. Keep it that way unless there's a strong reason.
- UI text is **English**. Code comments may be mixed.
- No secrets, no network calls except to the configured Ollama endpoint.

## Known limitations / possible next steps

- **OCR gap:** small VLMs read in-image text unreliably — the weakest point for
  text-based cases (memes with explicit captions). Options: a dedicated OCR describe
  layer, or a stronger vision model.
- **Not a security boundary:** this is a client-side tool/prototype. For production, run
  the two Ollama calls **server-side** and enforce there — a browser check is bypassable.
- Other ideas discussed: dedicated NSFW classifier as a hard pre-gate, `num_predict`
  slider, stage-batching (describe-all-then-decide-all) for throughput.
