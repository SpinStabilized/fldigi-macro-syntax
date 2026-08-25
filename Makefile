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
RSYNC_FLAGS   := -avh --progress

# Files and folders to exclude from the transfer
EXCLUDES      :=  

grammar: ## Regenerate the grammar + tag data from the fldigi source (FLDIGI_SRC=...)
	@echo "=== GENERATING GRAMMAR FROM FLDIGI SOURCE ==="
	python3 tools/gen_grammar.py --fldigi-src $(FLDIGI_SRC) --out-dir .
.PHONY: grammar

check-grammar: ## Fail if the committed grammar is stale vs the fldigi source
	@echo "=== CHECKING GRAMMAR IS UP TO DATE ==="
	python3 tools/gen_grammar.py --fldigi-src $(FLDIGI_SRC) --out-dir . --check
.PHONY: check-grammar

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