#!/usr/bin/env bash
# Start an isolated, invisible Obsidian on test-vault/ with remote debugging (CDP on :9333).
# Uses its own profile dir, so the user's running Obsidian is never touched.
#   scripts/obsidian-headless.sh [mobile|desktop]     (default: desktop)
#   scripts/obsidian-headless.sh stop
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
profile="${EPP_OBSIDIAN_PROFILE:-${TMPDIR:-/tmp}/epp-obsidian-profile}"
port=9333

if [ "${1:-}" = "stop" ]; then
	pkill -f -- "--user-data-dir=$profile" || true
	exit 0
fi

mkdir -p "$profile"
if [ ! -f "$profile/obsidian.json" ]; then
	echo "{\"vaults\":{\"e9f0a1b2c3d4e5f6\":{\"path\":\"$root/test-vault\",\"ts\":$(date +%s%3N),\"open\":true}},\"updateDisabled\":true}" > "$profile/obsidian.json"
fi
pkill -f -- "--user-data-dir=$profile" || true
sleep 1
rm -f "$root"/test-vault/.obsidian/workspace*.json   # stale layouts cause "plugin no longer active" tabs
(electron43 /usr/lib/obsidian/app.asar --user-data-dir="$profile" --ozone-platform=headless --disable-gpu \
	--remote-debugging-port=$port > "$profile/obsidian.log" 2>&1 &)

# Wait for the page, enable plugins (first run asks to trust the vault), size the window.
for _ in $(seq 1 40); do curl -s "localhost:$port/json" | grep -q app://obsidian.md && break; sleep 0.5; done
sleep 4
mode="${1:-desktop}"
bun "$root/scripts/cdp.ts" --port $port --eval "(async()=>{
	document.querySelector('.mod-trust-folder button.mod-cta')?.click();
	if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
	app.setting?.close?.();
	const mobile = '$mode' === 'mobile';
	if (app.isMobile !== mobile) app.emulateMobile(mobile);
	return 'ok';
})()" > /dev/null
sleep 5
size=$([ "$mode" = "mobile" ] && echo "420,880" || echo "1400,900")
bun "$root/scripts/cdp.ts" --port $port --eval "require('@electron/remote').getCurrentWindow().setSize($size); app.isMobile" 
echo "headless Obsidian ($mode) on :$port, profile $profile"
