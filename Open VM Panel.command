#!/bin/bash
# Double-click this from Finder to open VM Panel.
# It starts the panel if it is not already running, then opens it in your browser.

NODE=/opt/homebrew/bin/node
SERVER=/Users/mac/vm-panel/server.js
# Use the IPv4 loopback: the panel binds 0.0.0.0 (IPv4), and "localhost" can
# resolve to IPv6 (::1) which the panel does not listen on.
URL=http://127.0.0.1:5050
LOG="$HOME/Library/Logs/vm-panel.log"

if ! /usr/bin/curl -s -o /dev/null --max-time 3 "$URL/healthz"; then
  echo "Starting VM Panel…"
  mkdir -p "$HOME/Library/Logs"
  nohup "$NODE" "$SERVER" > "$LOG" 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    /usr/bin/curl -s -o /dev/null --max-time 2 "$URL/healthz" && break
    sleep 0.5
  done
fi

echo "Opening $URL"
/usr/bin/open "$URL"
