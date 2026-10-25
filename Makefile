# pi-hunt — convenience targets. Run `make help` for the list.
.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash

.PHONY: help install full extras dry rag prompts prompts-check gate-repo gate-selftest skills-manifest hooks token-report tier-on tier-off status uninstall-note

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

prompts: ## Rebuild agent prompts from pi-agent/prompts/ (backs up .bak-<ts>)
	@node bin/prompt-build.mjs

prompts-check: ## Full prompt gate: drift + signature + references + budgets + schema
	@node bin/prompt-gate.mjs

gate-repo: ## Prompt gate, repo-only (CI mode: no deployed tree)
	@node bin/prompt-gate.mjs --repo

gate-selftest: ## Prove the reference gate fails on each defect class
	@node bin/ref-check-selftest.mjs

skills-manifest: ## Regenerate skills/manifest.json from the repo skill tree
	@node bin/skill-manifest.mjs

hooks: ## Install the git hooks (committed in .githooks/)
	@git config core.hooksPath .githooks
	@chmod +x .githooks/*
	@echo "core.hooksPath -> .githooks"

token-report: ## Per-agent before/after token table
	@node bin/tally.mjs

install: ## Install the Kimi Code runtime (agents, MCPs, prompts, RAG)
	@bash install.sh

full: ## Install framework + recon CLIs & SecLists (needs sudo)
	@bash bootstrap.sh --with-extras

extras: ## Install only the runtime recon toolchain (needs sudo)
	@bash extras.sh

dry: ## Preview the full install without changing anything (runs the prompt gate first)
	@node bin/prompt-gate.mjs
	@bash bootstrap.sh --dry-run

rag: ## (Re)build the RAG index only
	@bash rag/install-rag.sh

tier-on: ## Cost tiering ON (mechanical agents -> cheaper model)
	@pi-tier on

tier-off: ## Cost tiering OFF (all agents -> flagship)
	@pi-tier off

status: ## Show per-agent models and RAG stats
	@pi-tier status; echo; pihunt-rag stats 2>/dev/null || true
