#!/bin/sh
# Virtual screen + VNC (viewed through the app at /vnc/) + a normal Chromium with the agent extension.
set -e
cd "$(dirname "$0")"
DATA_DIR=${DATA_DIR:-/data}
export DISPLAY=:99
Xvfb :99 -screen 0 1280x960x24 -nolisten tcp &
sleep 1
x11vnc -display :99 -forever -shared -localhost -nopw -quiet -rfbport 5900 >/dev/null 2>&1 &
websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/dev/null 2>&1 &
rm -f "$DATA_DIR"/profile/Singleton* # stale lock from a previous container
# Chromium keeps running the old extension worker code after an update unless its cache is cleared.
# (Only caches live here; ChatGPT/Claude logins are cookies and stay.)
rm -rf "$DATA_DIR/profile/Default/Service Worker"
(
  while true; do
    ${CHROME:-chromium} --user-data-dir="$DATA_DIR/profile" --no-sandbox --disable-dev-shm-usage \
      --load-extension="$PWD/extension" --disable-features=DisableLoadExtensionCommandLineSwitch \
      --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
      --no-first-run --no-default-browser-check --hide-crash-restore-bubble --window-position=0,0 --window-size=1280,960 \
      $CHROME_FLAGS "https://chatgpt.com/?temporary-chat=true" >/dev/null 2>&1 || true
    sleep 3 # restart if it crashes or gets closed
  done
) &
exec node server/index.js
