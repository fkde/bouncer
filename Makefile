# Bouncer — run `make` (or `make help`) for the list of targets.
#
# Two ways to run it, both in Docker on port $(BOUNCER_PORT):
#   make dev    build from source, overrides ON  — for working on it
#   make prod   published image,   overrides OFF — for deploying it
# They share the compose project name, so starting one replaces the other.
#
# Override config on the CLI, e.g.:
#   make release DOCKER_USER=acme TAG=1.0.0
#   make dev BOUNCER_PORT=9090

DOCKER_USER ?= fkde
IMAGE       ?= $(DOCKER_USER)/bouncer
TAG         ?= latest
PLATFORMS   ?= linux/amd64,linux/arm64
COMPOSE     ?= docker compose
PROD        ?= $(COMPOSE) -f docker-compose.prod.yml
PROD_GPU    ?= $(PROD) -f docker-compose.gpu.yml

.DEFAULT_GOAL := help

## help: show this help
help:
	@echo "Bouncer — targets:"
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //' | awk -F': ' '{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  image = $(IMAGE):$(TAG)   (override with DOCKER_USER / IMAGE / TAG)"

# ---------- Running it ----------

## dev: install deps, build and run in the foreground — overrides ON, demo UI on
dev: install
	ALLOW_OVERRIDES=true SERVE_UI=true $(COMPOSE) up --build

## prod: run the published image in the background — overrides OFF, needs API_TOKEN
prod:
	IMAGE=$(IMAGE):$(TAG) ALLOW_OVERRIDES=false $(PROD) up -d

## prod-gpu: same as prod, but the -gpu image with the NVIDIA device passed through
prod-gpu:
	IMAGE=$(IMAGE):$(TAG)-gpu ALLOW_OVERRIDES=false $(PROD_GPU) up -d

## down: stop and remove the container (works for dev and prod)
down:
	$(COMPOSE) down

## logs: follow the logs
logs:
	$(COMPOSE) logs -f

## ps: show container status
ps:
	$(COMPOSE) ps

## shell: open a shell inside the running container
shell:
	$(COMPOSE) exec bouncer sh

## pull: download a model into the running container — make pull MODEL=gemma4:e4b
pull:
	@test -n "$(MODEL)" || { echo "Usage: make pull MODEL=<ollama-tag>"; exit 1; }
	$(COMPOSE) exec bouncer pull-model.sh $(MODEL)

## token: print a fresh API_TOKEN line — append it with `make token >> .env`
token:
	@printf 'API_TOKEN=%s\n' "$$(openssl rand -hex 32)"

# ---------- Dependencies ----------
# The image installs its own deps; this is for your editor's autocompletion.

## install: install the Node dependencies locally (only if out of date)
install: classifier/node_modules

classifier/node_modules: classifier/package-lock.json
	cd classifier && npm ci
	@touch $@

## lock: refresh classifier/package-lock.json after a dependency change
lock:
	cd classifier && npm install --package-lock-only --omit=dev && npm audit --omit=dev

# ---------- Build & publish (Docker Hub) ----------
# CPU and GPU are separate tags on purpose — never build a GPU image under the
# plain tag, or a `docker pull :latest` on a GPU-less server gets CUDA libs.

## build: build the CPU image locally as $(IMAGE):$(TAG)
build:
	docker build --build-arg VERSION=$(TAG) --build-arg GPU=false -t $(IMAGE):$(TAG) .

## build-gpu: build the NVIDIA image locally as $(IMAGE):$(TAG)-gpu
build-gpu:
	docker build --build-arg VERSION=$(TAG)-gpu --build-arg GPU=true -t $(IMAGE):$(TAG)-gpu .

## push: push $(IMAGE):$(TAG) to Docker Hub (run `docker login` first)
push:
	docker push $(IMAGE):$(TAG)

## release: multi-arch CPU build + push (needs buildx + docker login)
release:
	docker buildx build --platform $(PLATFORMS) --build-arg VERSION=$(TAG) --build-arg GPU=false -t $(IMAGE):$(TAG) --push .

## release-gpu: build + push the NVIDIA image as $(IMAGE):$(TAG)-gpu (amd64 only)
release-gpu:
	docker buildx build --platform linux/amd64 --build-arg VERSION=$(TAG)-gpu --build-arg GPU=true -t $(IMAGE):$(TAG)-gpu --push .

## release-all: CPU + GPU images and the Docker Hub overview, in one go
release-all: release release-gpu hub-readme

## hub-readme: upload DOCKERHUB.md to the Hub repo overview (needs docker-pushrm)
hub-readme:
	docker pushrm $(IMAGE) --file DOCKERHUB.md

.PHONY: help dev prod prod-gpu down logs ps shell pull token install lock \
        build build-gpu push release release-gpu release-all hub-readme
