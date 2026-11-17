#!/bin/sh
set -eu
mkdir -p /data
# Prevent simultaneous Chromium instances and counter writers on the same volume.
exec 9>/data/service.lock
flock -n 9 || { echo 'Profile is in use. Stop the login/monitor service first.'; exit 1; }
if [ "${1:-}" = login ]; then
  export DISPLAY=:99
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
  attempts=0
  until [ -S /tmp/.X11-unix/X99 ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 50 ] || { echo 'Xvfb did not start'; exit 1; }
    sleep 0.2
  done
  x11vnc -display :99 -rfbport 5900 -localhost -nopw -forever -shared -quiet &
  websockify --web=/usr/share/novnc/ 6080 localhost:5900 &
fi
exec node src/main.js "$@"
