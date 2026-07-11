#!/bin/bash
# VM Panel — restore data/ from a backup tarball made by backup.sh.
# Usage: launchers/restore.sh [/path/to/vm-panel-data_YYYY-MM-DD_HHMMSS.tar.gz]
# With no argument, restores the NEWEST archive in $VMP_BACKUP_DIR.
# Stops the panel, backs up the current data/ to data.pre-restore/, extracts,
# then tells you to start again. Safe: never deletes without a rollback copy.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

DATA_DIR="${VMP_DATA_DIR:-/Users/mac/vm-panel/data}"
BACKUP_DIR="${VMP_BACKUP_DIR:-$HOME/vm-panel-backups}"
LABEL="com.vmpanel"; DOMAIN="gui/$(id -u)"

ARCHIVE="${1:-}"
[ -z "$ARCHIVE" ] && ARCHIVE="$(ls -1t "$BACKUP_DIR"/vm-panel-data_*.tar.gz 2>/dev/null | head -1)"
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || { echo "ERROR: no backup archive found (looked in $BACKUP_DIR). Pass a path explicitly."; exit 1; }
tar -tzf "$ARCHIVE" >/dev/null 2>&1 || { echo "ERROR: archive is unreadable/corrupt: $ARCHIVE"; exit 1; }

echo "About to restore: $ARCHIVE"
echo "Into:            $DATA_DIR"
printf "This replaces the current data (a rollback copy is kept). Continue? [y/N] "
read -r ans; case "${ans:-}" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac

echo "Stopping the panel..."
launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
sleep 1

ROLLBACK="${DATA_DIR}.pre-restore_$(date +%Y-%m-%d_%H%M%S)"
if [ -d "$DATA_DIR" ]; then cp -a "$DATA_DIR" "$ROLLBACK" && echo "Rollback copy: $ROLLBACK"; fi
mkdir -p "$DATA_DIR"
tar -xzf "$ARCHIVE" -C "$DATA_DIR" || { echo "ERROR: extract failed — your data is unchanged in $ROLLBACK"; exit 1; }
chmod 700 "$DATA_DIR" 2>/dev/null || true
find "$DATA_DIR" -maxdepth 1 -type f -exec chmod 600 {} \; 2>/dev/null || true

echo "Restore complete. Start the panel again:  launchctl kickstart -k ${DOMAIN}/${LABEL}"
echo "(or double-click the Start VM Panel launcher). If anything is wrong, your previous data is in $ROLLBACK."
