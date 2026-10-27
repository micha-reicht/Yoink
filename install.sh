#!/bin/bash
# Installs yoink for Google Chrome on macOS. No admin rights needed.
#
# What it does:
#   1. checks that Google Chrome and python3 (Command Line Tools) are there
#   2. copies the helper and the extension to ~/Library/Application Support/yoink
#   3. tells Chrome where the helper is (a small file in Chrome's NativeMessagingHosts folder)
# Nothing is written unless all checks pass. Run it again to update; uninstall.sh removes it.
set -eu

NAME="io.yoink.helper"
HIER="$(cd "$(dirname "$0")" && pwd -P)"
ZIEL="$HOME/Library/Application Support/yoink"
NM_ORDNER="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
# Only for tests: replace what is checked
PYTHON="${YOINK_PYTHON:-/usr/bin/python3}"
XCODE_SELECT="${YOINK_XCODE_SELECT:-/usr/bin/xcode-select}"
CHROME_ORDNER="${YOINK_CHROME_DIRS:-/Applications:$HOME/Applications}"

fehlt=""
melden() { fehlt="${fehlt}  - $1
"; }

if [ "$(uname -s)" != "Darwin" ]; then
  echo "yoink runs on macOS only." >&2
  exit 1
fi

# Google Chrome
chrome=""
alt_ifs="$IFS"; IFS=":"
for o in $CHROME_ORDNER; do
  if [ -x "$o/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then chrome="$o/Google Chrome.app"; break; fi
done
IFS="$alt_ifs"
[ -n "$chrome" ] || melden "Google Chrome is not installed (looked in /Applications and ~/Applications). Get it from https://www.google.com/chrome/"

# python3 from the Command Line Tools. Without them, /usr/bin/python3 only opens an install dialog,
# so the tools are checked first.
if ! "$XCODE_SELECT" -p >/dev/null 2>&1; then
  melden "Apple's Command Line Tools are missing (they bring python3). Install them with: xcode-select --install"
elif [ ! -x "$PYTHON" ] || ! "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
  melden "python3 (3.8 or newer) does not work at $PYTHON. Install Apple's Command Line Tools with: xcode-select --install"
fi

for d in "$HIER/host/yoink_host.py" "$HIER/extension/manifest.json" "$HIER/uninstall.sh" "$HIER/README.md"; do
  [ -f "$d" ] || melden "This folder is incomplete: $d is missing. Unpack the yoink zip again."
done

if [ -n "$fehlt" ]; then
  printf 'yoink was NOT installed. Missing:\n%s' "$fehlt" >&2
  exit 1
fi

# Copy to a fixed place (a new copy first, then swap, so an update never leaves half a folder)
mkdir -p "$(dirname "$ZIEL")"
neu="$ZIEL.neu.$$"
rm -rf "$neu"
mkdir "$neu"
cp -R "$HIER/host" "$HIER/extension" "$neu/"
cp "$HIER/uninstall.sh" "$HIER/README.md" "$neu/"
find "$neu" -name '__pycache__' -type d -prune -exec rm -rf {} +
chmod 755 "$neu/host/yoink_host.py"
rm -rf "$ZIEL"
mv "$neu" "$ZIEL"

# Tell Chrome where the helper is; only this extension (ID from the key in its manifest) may call it
mkdir -p "$NM_ORDNER"
ext_id="$("$PYTHON" - "$ZIEL/extension/manifest.json" "$ZIEL/host/yoink_host.py" "$NM_ORDNER/$NAME.json" "$NAME" <<'PY'
import base64, hashlib, json, sys
manifest, host, datei, name = sys.argv[1:]
key = json.load(open(manifest))["key"]
h = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
ext_id = "".join(chr(ord("a") + int(c, 16)) for c in h)
with open(datei, "w") as f:
    json.dump({"name": name, "description": "yoink helper: saves catches and checks the render",
               "path": host, "type": "stdio", "allowed_origins": [f"chrome-extension://{ext_id}/"]}, f, indent=2)
print(ext_id)
PY
)"

cat <<TEXT
yoink is installed.

Next, load the extension in Chrome (once):
  1. Open chrome://extensions
  2. Turn on "Developer mode" (top right)
  3. Click "Load unpacked" and choose this folder:
       $ZIEL/extension
     (In the dialog, press Cmd+Shift+G and paste the path.)
  4. Check that the extension ID is $ext_id

Then press Option+Shift+Y on any page. On the first catch yoink asks where to save.
TEXT
