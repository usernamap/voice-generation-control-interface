SHELL := /bin/bash
.DEFAULT_GOAL := help

ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
BACKEND_DIR := $(ROOT_DIR)/CosyVoice
FRONTEND_DIR := $(ROOT_DIR)/frontend
BACKEND_PYTHON := $(BACKEND_DIR)/.venv/bin/python
API_HOST ?= 127.0.0.1
API_PORT ?= 8000

.PHONY: help install install-backend install-frontend dev dev-backend dev-frontend lint lint-backend lint-frontend build build-frontend

help:
	@echo "Monorepo commands"
	@echo "  make install           Install backend + frontend dependencies"
	@echo "  make install-backend   Create backend .venv (if missing) and install deps"
	@echo "  make install-frontend  Install frontend deps"
	@echo "  make dev               Run backend and frontend together"
	@echo "  make dev-backend       Run backend API only"
	@echo "  make dev-frontend      Run frontend only"
	@echo "  make lint              Run backend syntax check + frontend lint"
	@echo "  make build             Build frontend"
	@echo "  overrides: API_HOST=127.0.0.1 API_PORT=8000"

install: install-backend install-frontend

install-backend:
	@cd "$(BACKEND_DIR)" && \
	if [[ ! -d ".venv" ]]; then python3 -m venv .venv; fi && \
	"$(BACKEND_PYTHON)" -m ensurepip --upgrade >/dev/null 2>&1 || true && \
	"$(BACKEND_PYTHON)" -m pip install --upgrade pip && \
	"$(BACKEND_PYTHON)" -m pip install -r requirements.macos.inference.txt

install-frontend:
	@cd "$(FRONTEND_DIR)" && npm install

dev:
	@COSYVOICE_API_HOST="$(API_HOST)" COSYVOICE_API_PORT="$(API_PORT)" bash "$(ROOT_DIR)/scripts/dev-all.sh"

dev-backend:
	@if lsof -nP -iTCP:$(API_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "Backend port $(API_PORT) is already in use."; \
		lsof -nP -iTCP:$(API_PORT) -sTCP:LISTEN; \
		echo "Stop that process or run: make dev-backend API_PORT=8001"; \
		exit 1; \
	fi
	@cd "$(BACKEND_DIR)" && \
	if [[ -x ".venv/bin/python" ]]; then \
		COSYVOICE_API_HOST="$(API_HOST)" COSYVOICE_API_PORT="$(API_PORT)" .venv/bin/python tools/run_api_server.py; \
	else \
		COSYVOICE_API_HOST="$(API_HOST)" COSYVOICE_API_PORT="$(API_PORT)" python3 tools/run_api_server.py; \
	fi

dev-frontend:
	@cd "$(FRONTEND_DIR)" && npm run dev

lint: lint-backend lint-frontend

lint-backend:
	@cd "$(BACKEND_DIR)" && python3 -m py_compile api_server/main.py cosyvoice/llm/llm.py

lint-frontend:
	@cd "$(FRONTEND_DIR)" && npm run lint

build: build-frontend

build-frontend:
	@cd "$(FRONTEND_DIR)" && npm run build
