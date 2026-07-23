PORT ?= 8000

.PHONY: start serve open ollama-cors help

## start: Lokalen Webserver starten und Browser öffnen
start: open serve

## serve: Nur den lokalen Webserver starten (http://localhost:$(PORT))
serve:
	@echo "→ Server läuft auf http://localhost:$(PORT)  (Strg+C zum Beenden)"
	@python3 -m http.server $(PORT)

## open: Browser auf die App öffnen
open:
	@open "http://localhost:$(PORT)" || true

## ollama-cors: OLLAMA_ORIGINS für localhost:$(PORT) setzen (Ollama danach neu starten!)
ollama-cors:
	@launchctl setenv OLLAMA_ORIGINS "http://localhost:$(PORT)"
	@echo "OLLAMA_ORIGINS gesetzt auf: $$(launchctl getenv OLLAMA_ORIGINS)"
	@echo "→ Jetzt Ollama beenden und neu starten, damit es greift."

## help: Diese Übersicht anzeigen
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //'
