#!/bin/bash
# Removes yoink: the helper in ~/Library/Application Support/yoink and Chrome's entry for it.
# Your saved catches stay where they are. The extension itself is removed in Chrome.
set -eu

NAME="io.yoink.helper"
ZIEL="$HOME/Library/Application Support/yoink"
EINTRAG="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$NAME.json"

rm -rf "$ZIEL"
rm -f "$EINTRAG"
# Chrome's folder for helper entries only if yoink's entry was the last one in it
rmdir "$(dirname "$EINTRAG")" 2>/dev/null || true

cat <<TEXT
yoink's helper is removed.

To finish, remove the extension in Chrome: open chrome://extensions and click "Remove" on yoink.
Your saved catches were not touched.
TEXT
