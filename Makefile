SHELL := /bin/bash
.DEFAULT_GOAL := help

ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
SSOT_CONFIG := $(ROOT_DIR)/config/ssot.env

ifeq (,$(wildcard $(SSOT_CONFIG)))
$(error Missing SSOT config file: $(SSOT_CONFIG))
endif

include $(SSOT_CONFIG)
export $(shell sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' $(SSOT_CONFIG))

define assert_defined
$(if $(strip $($(1))),,$(error Missing required key '$(1)' in $(SSOT_CONFIG)))
endef

$(foreach key,MONOREPO_BACKEND_DIR MONOREPO_FRONTEND_DIR MONOREPO_BACKEND_PYTHON MONOREPO_BACKEND_ENTRYPOINT MONOREPO_BACKEND_REQUIREMENTS COSYVOICE_API_HOST COSYVOICE_API_PORT FRONTEND_HOST FRONTEND_PORT NEXT_PUBLIC_API_BASE COSYVOICE_WEBUI_HOST COSYVOICE_WEBUI_PORT COSYVOICE_CORS_ORIGINS TOKENIZERS_PARALLELISM COSYVOICE_MODEL_DIR COSYVOICE_API_OUTPUT_DIR COSYVOICE_API_HISTORY_SIZE COSYVOICE_API_AUDIT_SIZE COSYVOICE_API_SUGGESTIONS_PER_FIELD COSYVOICE_API_MAX_UPLOAD_BYTES,$(eval $(call assert_defined,$(key))))

BACKEND_DIR := $(ROOT_DIR)/$(MONOREPO_BACKEND_DIR)
FRONTEND_DIR := $(ROOT_DIR)/$(MONOREPO_FRONTEND_DIR)
BACKEND_PYTHON := $(BACKEND_DIR)/$(MONOREPO_BACKEND_PYTHON)
BACKEND_ENTRYPOINT := $(BACKEND_DIR)/$(MONOREPO_BACKEND_ENTRYPOINT)

.PHONY: help check-ssot install install-backend install-frontend dev dev-backend dev-frontend dev-webui lint lint-backend lint-frontend build build-frontend

help:
	@echo "Monorepo commands (SSOT: $(SSOT_CONFIG))"
	@echo "  make check-ssot        Validate SSOT config completeness"
	@echo "  make install           Install backend + frontend dependencies"
	@echo "  make install-backend   Create backend .venv (if missing) and install deps"
	@echo "  make install-frontend  Install frontend deps"
	@echo "  make dev               Run backend and frontend together"
	@echo "  make dev-backend       Run backend API only"
	@echo "  make dev-frontend      Run frontend only"
	@echo "  make dev-webui         Run CosyVoice WebUI"
	@echo "  make lint              Run backend syntax check + frontend lint"
	@echo "  make build             Build frontend"

check-ssot:
	@bash "$(ROOT_DIR)/scripts/load-ssot-env.sh"

install: check-ssot install-backend install-frontend

install-backend:
	@cd "$(BACKEND_DIR)" && \
	if [[ ! -d ".venv" ]]; then python3 -m venv .venv; fi && \
	"$(BACKEND_PYTHON)" -m ensurepip --upgrade >/dev/null 2>&1 || true && \
	"$(BACKEND_PYTHON)" -m pip install --upgrade pip && \
	"$(BACKEND_PYTHON)" -m pip install -r "$(MONOREPO_BACKEND_REQUIREMENTS)"

install-frontend:
	@cd "$(FRONTEND_DIR)" && npm install

dev:
	@bash "$(ROOT_DIR)/scripts/dev-all.sh"

dev-backend:
	@if lsof -nP -iTCP:$(COSYVOICE_API_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "Backend port $(COSYVOICE_API_PORT) is already in use."; \
		lsof -nP -iTCP:$(COSYVOICE_API_PORT) -sTCP:LISTEN; \
		echo "Stop that process or change COSYVOICE_API_PORT in $(SSOT_CONFIG)."; \
		exit 1; \
	fi
	@cd "$(BACKEND_DIR)" && \
	TOKENIZERS_PARALLELISM="$(TOKENIZERS_PARALLELISM)" \
	COSYVOICE_API_HOST="$(COSYVOICE_API_HOST)" \
	COSYVOICE_API_PORT="$(COSYVOICE_API_PORT)" \
	COSYVOICE_MODEL_DIR="$(COSYVOICE_MODEL_DIR)" \
	COSYVOICE_API_OUTPUT_DIR="$(COSYVOICE_API_OUTPUT_DIR)" \
	COSYVOICE_API_HISTORY_SIZE="$(COSYVOICE_API_HISTORY_SIZE)" \
	COSYVOICE_API_AUDIT_SIZE="$(COSYVOICE_API_AUDIT_SIZE)" \
	COSYVOICE_API_SUGGESTIONS_PER_FIELD="$(COSYVOICE_API_SUGGESTIONS_PER_FIELD)" \
	COSYVOICE_API_MAX_UPLOAD_BYTES="$(COSYVOICE_API_MAX_UPLOAD_BYTES)" \
	COSYVOICE_CORS_ORIGINS="$(COSYVOICE_CORS_ORIGINS)" \
	"$(BACKEND_PYTHON)" "$(BACKEND_ENTRYPOINT)"

dev-frontend:
	@cd "$(FRONTEND_DIR)" && \
	NEXT_PUBLIC_API_BASE="$(NEXT_PUBLIC_API_BASE)" \
	npm run dev -- --hostname "$(FRONTEND_HOST)" --port "$(FRONTEND_PORT)"

dev-webui:
	@cd "$(BACKEND_DIR)" && \
	TOKENIZERS_PARALLELISM="$(TOKENIZERS_PARALLELISM)" \
	"$(BACKEND_PYTHON)" webui.py --host "$(COSYVOICE_WEBUI_HOST)" --port "$(COSYVOICE_WEBUI_PORT)" --model_dir "$(COSYVOICE_MODEL_DIR)"

lint: check-ssot lint-backend lint-frontend

lint-backend:
	@cd "$(BACKEND_DIR)" && python3 -m py_compile api_server/main.py api_server/ssot.py tools/run_api_server.py

lint-frontend:
	@cd "$(FRONTEND_DIR)" && NEXT_PUBLIC_API_BASE="$(NEXT_PUBLIC_API_BASE)" npm run lint

build: check-ssot build-frontend

build-frontend:
	@cd "$(FRONTEND_DIR)" && NEXT_PUBLIC_API_BASE="$(NEXT_PUBLIC_API_BASE)" npm run build
