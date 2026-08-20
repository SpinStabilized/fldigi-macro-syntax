# Makefile for deploying vscode syntax highlighter updates to the .vscode/extensions directory

SRC_DIR       := ./
DEST_DIR      := ~/.vscode/extensions/fldigi-macro-syntax/

# --- RSYNC FLAGS ---
# -a: archive mode (preserves links, times, permissions, owners, etc.)
# -v: verbose output
# -h: human-readable numbers
# --progress: show progress bar during transfer
RSYNC_FLAGS   := -avh --progress

# Files and folders to exclude from the transfer
EXCLUDES      := --exclude='.git/' --exclude='.gitignore' --exclude='.vscode/' --exclude='.vscodeignore' --exclude='Makefile' 

dry-run: ## Lets you know what files will be exchanged
	@echo "=== SIMULATING LOCAL SYNC (DRY RUN) ==="
	rsync $(RSYNC_FLAGS) --dry-run $(EXCLUDES) $(SRC_DIR) $(DEST_DIR)
.PHONY: dry-run

sync: ## Sync updates between the source dir and the active dir
	@echo "=== EXECUTING LOCAL SYNC ==="
	rsync $(RSYNC_FLAGS) $(EXCLUDES) $(SRC_DIR) $(DEST_DIR)
.PHONY: sync

help: ## Show this help
	@egrep -h '\s##\s' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'
.PHONY: help
.DEFAULT_GOAL = help