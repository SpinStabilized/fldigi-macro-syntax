# Makefile for deploying vscode syntax highlighter updates to the .vscode/extensions directory

SRC_DIR       := ./extension/
DEST_DIR      := ~/.vscode/extensions/fldigi-macro-syntax/

# Path to an unpacked fldigi source tree. Override on the command line:
#   make grammar FLDIGI_SRC=~/src/fldigi-4.2.13
FLDIGI_SRC    ?= ~/source/fldigi

# --- RSYNC FLAGS ---
# -a: archive mode (preserves links, times, permissions, owners, etc.)
# -v: verbose output
# -h: human-readable numbers
# --progress: show progress bar during transfer
# --delete: remove files in DEST that no longer exist in SRC
RSYNC_FLAGS   := -avh --progress --delete

EXCLUDES      :=

grammar: ## Regenerate the grammar + tag data from the fldigi source (FLDIGI_SRC=...)
	@echo "=== GENERATING GRAMMAR FROM FLDIGI SOURCE ==="
	python3 tools/gen_grammar.py --fldigi-src $(FLDIGI_SRC) --out-dir .
.PHONY: grammar

check-grammar: ## Fail if the committed grammar is stale vs the fldigi source
	@echo "=== CHECKING GRAMMAR IS UP TO DATE ==="
	python3 tools/gen_grammar.py --fldigi-src $(FLDIGI_SRC) --out-dir . --check
.PHONY: check-grammar

# Local TypeScript binary. Used directly rather than via bare `npx tsc`:
# if typescript is not installed, npx will silently fetch and run an unrelated
# package from the registry that happens to be named "tsc".
TSC           := ./node_modules/.bin/tsc

deps: ## Install the dev tooling (typescript + type stubs) into ./node_modules
	@echo "=== INSTALLING DEV DEPENDENCIES ==="
	npm install
.PHONY: deps

typecheck: ## Type-check the extension JavaScript (run 'make deps' first)
	@echo "=== TYPE CHECKING ==="
	@test -f jsconfig.json || { \
		echo ""; \
		echo "jsconfig.json is missing from the repo root."; \
		echo "It tells tsc which files to check and turns on checkJs/strict."; \
		echo ""; \
		exit 1; \
	}
	@test -x $(TSC) || { \
		echo ""; \
		echo "TypeScript is not installed locally."; \
		echo "Run 'make deps' first (this installs into ./node_modules)."; \
		echo ""; \
		exit 1; \
	}
	$(TSC) -p jsconfig.json
.PHONY: typecheck

test: ## Run the diagnostics test suite
	@echo "=== RUNNING DIAGNOSTICS TESTS ==="
	node test/run-tests.js
.PHONY: test

check: check-grammar typecheck test ## Run every check (use this in CI)
.PHONY: check

dry-run: ## Lets you know what files will be exchanged on deployment
	@echo "=== SIMULATING LOCAL SYNC (DRY RUN) ==="
	rsync $(RSYNC_FLAGS) --dry-run $(EXCLUDES) $(SRC_DIR) $(DEST_DIR)
.PHONY: dry-run

sync: ## Sync updates between the source dir and the active dir
	@echo "=== EXECUTING LOCAL SYNC ==="
	rsync $(RSYNC_FLAGS) $(EXCLUDES) $(SRC_DIR) $(DEST_DIR)
	@echo ""
	@echo "Reload the VS Code window to pick up changes:"
	@echo "  Cmd/Ctrl+Shift+P -> Developer: Reload Window"
.PHONY: sync

help: ## Show this help
	@egrep -h '\s##\s' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'
.PHONY: help
.DEFAULT_GOAL = help