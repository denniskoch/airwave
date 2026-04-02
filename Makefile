.PHONY: help install dev start docker-build docker-up docker-down docker-logs clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

dev: ## Run dev server with hot reload
	npm run dev

start: ## Run production server
	npm start

docker-build: ## Build Docker image
	docker compose build

docker-up: ## Start via Docker Compose
	docker compose up -d

docker-down: ## Stop Docker Compose
	docker compose down

docker-logs: ## Tail Docker logs
	docker compose logs -f

clean: ## Remove node_modules
	rm -rf node_modules
