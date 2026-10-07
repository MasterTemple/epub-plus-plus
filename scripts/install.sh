#!/usr/bin/env bash
# Build EPUB++ and copy it into a vault's plugin folder (real files, not symlinks, so it syncs to mobile).
#   scripts/install.sh ~/Obsidian
set -euo pipefail

if [ $# -ne 1 ]; then
	echo "usage: $0 <vault-dir>" >&2
	exit 1
fi

vault="${1%/}"
if [ ! -d "$vault/.obsidian" ]; then
	echo "error: '$vault' is not an Obsidian vault (no .obsidian folder)" >&2
	exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$root/packages/obsidian/dist"
id="$(sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' "$root/packages/obsidian/manifest.json")"
dest="$vault/.obsidian/plugins/$id"

(cd "$root" && bun run build)

# Replace a dev symlink with a real folder; keep data.json (settings, reading positions).
if [ -L "$dest" ]; then
	rm "$dest"
fi
mkdir -p "$dest"
for f in main.js manifest.json styles.css; do
	cp "$dist/$f" "$dest/$f"
done

echo "Installed $id $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$dist/manifest.json") to $dest"
echo "Reload Obsidian (or toggle the plugin) and enable it under Settings → Community plugins."
