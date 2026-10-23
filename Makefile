# pi-hunt — convenience targets. Run `make help` for the list.
.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash

.PHONY: help install full extras dry rag tier-on tier-off status uninstall-note

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install the OpenRouter runtime (agents, MCPs, prompts, RAG)
	@bash install.sh

full: ## Install framework + recon CLIs & SecLists (needs sudo)
	@bash bootstrap.sh --with-extras

extras: ## Install only the runtime recon toolchain (needs sudo)
	@bash extras.sh

dry: ## Preview the full install without changing anything
	@bash bootstrap.sh --dry-run

rag: ## (Re)build the RAG index only
	@bash rag/install-rag.sh

tier-on: ## Cost tiering ON (mechanical agents -> cheaper model)
	@pi-tier on

tier-off: ## Cost tiering OFF (all agents -> flagship)
	@pi-tier off

status: ## Show per-agent models and RAG stats
	@pi-tier status; echo; pihunt-rag stats 2>/dev/null || true
