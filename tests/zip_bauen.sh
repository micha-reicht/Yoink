#!/bin/bash
# Baut yoink-<version>.zip: nur README.md, install.sh, uninstall.sh, extension/ und host/yoink_host.py.
# Vorher Weitergabe-Pruefung (Selbsttest, dann der echte Inhalt); mit Fund kein Zip.
#
#   zip_bauen.sh [zielordner]     Standard: ~/Desktop
set -euo pipefail

HIER="$(cd "$(dirname "$0")" && pwd -P)"
WERKZEUG="$(dirname "$HIER")"
ZIEL="${1:-$HOME/Desktop}"
VERSION="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$WERKZEUG/extension/manifest.json")"
HOSTVERSION="$(/usr/bin/grep -E '^VERSION = ' "$WERKZEUG/host/yoink_host.py" | cut -d'"' -f2)"
[ "$VERSION" = "$HOSTVERSION" ] || { echo "Version passt nicht: Extension $VERSION, Host $HOSTVERSION" >&2; exit 1; }

/usr/bin/python3 "$HIER/pruef_weitergabe.py" --selftest

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
inhalt="$tmp/yoink-$VERSION"
mkdir -p "$inhalt/host"
cp "$WERKZEUG/README.md" "$WERKZEUG/install.sh" "$WERKZEUG/uninstall.sh" "$inhalt/"
cp -R "$WERKZEUG/extension" "$inhalt/"
cp "$WERKZEUG/host/yoink_host.py" "$inhalt/host/"
chmod 755 "$inhalt/install.sh" "$inhalt/uninstall.sh" "$inhalt/host/yoink_host.py"
find "$inhalt" \( -name '.DS_Store' -o -name '__pycache__' \) -prune -exec rm -rf {} +

/usr/bin/python3 "$HIER/pruef_weitergabe.py" "$inhalt"

zipdatei="$ZIEL/yoink-$VERSION.zip"
rm -f "$zipdatei"
(cd "$tmp" && /usr/bin/zip -qrX "$zipdatei" "yoink-$VERSION")
echo "gebaut: $zipdatei ($(/usr/bin/unzip -l "$zipdatei" | tail -1 | awk '{print $2}') Dateien)"
