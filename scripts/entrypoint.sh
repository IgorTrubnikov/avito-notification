#!/bin/sh
set -eu
mkdir -p /data
# Prevent simultaneous Chromium instances and counter writers on the same volume.
exec 9>/data/service.lock
flock -n 9 || { echo 'Profile is in use. Stop the login/monitor service first.'; exit 1; }
# The flock is shared by login and monitor; only its owner may clean Chromium's
# symlinks, which can retain the previous container's hostname after shutdown.
case "${1:-monitor}" in
  login|monitor)
    for name in SingletonLock SingletonCookie SingletonSocket; do
      path="/data/profile/$name"
      if [ -L "$path" ]; then
        rm -- "$path"
      elif [ -e "$path" ]; then
        echo "Unexpected Chromium lock file; refusing to remove: $name"
        exit 1
      fi
    done
    ;;
esac
with_display=false
if [ "${1:-}" = login ]; then
  with_display=true
elif [ "${1:-monitor}" = monitor ] && [ "${MONITOR_HEADLESS:-true}" = false ]; then
  with_display=true
fi
if [ "$with_display" = true ]; then
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
