#!/usr/bin/env bash
# Download sample EPUBs used by the browser tests, the demo, and the test vault.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p fixtures test-vault/Books
dl() { [ -f "$2" ] || curl -sSL -o "$2" "$1"; }
dl https://github.com/IDPF/epub3-samples/releases/download/20230704/moby-dick.epub fixtures/moby-dick.epub
dl https://github.com/IDPF/epub3-samples/releases/download/20230704/accessible_epub_3.epub fixtures/accessible.epub
dl "https://www.gutenberg.org/ebooks/11.epub.noimages" fixtures/alice-gutenberg.epub
dl "https://www.gutenberg.org/ebooks/1342.epub3.images" fixtures/pride.epub
cp -n fixtures/moby-dick.epub "test-vault/Books/Moby Dick.epub"
cp -n fixtures/alice-gutenberg.epub test-vault/Books/Alice.epub
cp -n fixtures/pride.epub "test-vault/Books/Pride and Prejudice.epub"
echo "fixtures ready"
