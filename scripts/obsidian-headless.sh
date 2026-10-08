#!/usr/bin/env bash
# Isolated headless Obsidian on test-vault/ (see file-plus-plus/scripts/obsidian-headless.sh).
#   scripts/obsidian-headless.sh [mobile|desktop|stop]
root="$(cd "$(dirname "$0")/.." && pwd)"
FPP_VAULT="$root/test-vault" FPP_CDP_PORT="${FPP_CDP_PORT:-${EPP_CDP_PORT:-9333}}" exec "$root/node_modules/file-plus-plus/scripts/obsidian-headless.sh" "$@"
