#!/bin/bash
# VM Panel — automated backup of the stateful data/ directory.
# Writes a timestamped tarball to $VMP_BACKUP_DIR (default ~/vm-panel-backups),
# prunes to the last $VMP_BACKUP_KEEP copies, and verifies the archive.
# Point VMP_BACKUP_DIR at a mounted volume / synced folder / rclone remote path
# for OFF-HOST durability. Run by the com.vmpanel.backup launchd timer (daily),
# or by hand: VMP_BACKUP_DIR=/Volumes/backup launchers/backup.sh
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

DATA_DIR="${VMP_DATA_DIR:-/Users/mac/vm-panel/data}"
BACKUP_DIR="${VMP_BACKUP_DIR:-$HOME/vm-panel-backups}"
KEEP="${VMP_BACKUP_KEEP:-14}"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
OUT="$BACKUP_DIR/vm-panel-data_${STAMP}.tar.gz"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup: $*"; }

[ -d "$DATA_DIR" ] || { log "ERROR data dir not found: $DATA_DIR"; exit 1; }
mkdir -p "$BACKUP_DIR" || { log "ERROR cannot create $BACKUP_DIR"; exit 1; }

# Archive ALL durable state (never the access log or tmp files). NOTE: `secret`
# is included so a restore keeps existing sessions valid, but it also enables
# session-cookie forgery — keep VMP_BACKUP_DIR access-controlled / encrypted
# at rest (e.g. an encrypted volume or an rclone crypt remote).
tar -czf "$OUT" -C "$DATA_DIR" \
  $( [ -f "$DATA_DIR/users.json" ] && echo users.json ) \
  $( [ -f "$DATA_DIR/sessions.json" ] && echo sessions.json ) \
  $( [ -f "$DATA_DIR/machines.json" ] && echo machines.json ) \
  $( [ -f "$DATA_DIR/config.json" ] && echo config.json ) \
  $( [ -f "$DATA_DIR/usage.json" ] && echo usage.json ) \
  $( [ -f "$DATA_DIR/metrics.json" ] && echo metrics.json ) \
  $( [ -f "$DATA_DIR/alerts.jsonl" ] && echo alerts.jsonl ) \
  $( [ -f "$DATA_DIR/secret" ] && echo secret ) 2>/dev/null || { log "ERROR tar failed"; exit 1; }

chmod 600 "$OUT" 2>/dev/null || true
# Verify the archive is readable/intact before pruning older good copies.
if ! tar -tzf "$OUT" >/dev/null 2>&1; then log "ERROR archive verify failed: $OUT"; rm -f "$OUT"; exit 1; fi
# Record success so the panel can alert if backups go stale (deriveAlerts).
touch "$DATA_DIR/last-backup" 2>/dev/null || true
log "wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Retention: keep the newest $KEEP archives.
COUNT=$(ls -1t "$BACKUP_DIR"/vm-panel-data_*.tar.gz 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$KEEP" ]; then
  ls -1t "$BACKUP_DIR"/vm-panel-data_*.tar.gz | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old" && log "pruned $old"; done
fi
log "done ($COUNT kept, limit $KEEP)"
