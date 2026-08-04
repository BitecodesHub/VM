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

# Archive ALL durable state (never the access log or tmp files).
#
# NOTE on `secret`: included so a restore keeps existing sessions valid, but it
# also enables session-cookie forgery — keep VMP_BACKUP_DIR access-controlled and
# encrypted at rest (an encrypted volume, or an rclone crypt remote).
#
# The list below previously omitted four things that are NOT reconstructible:
#   audit.jsonl          the privileged-action trail (the compliance artefact —
#                        losing it defeats the purpose of having one)
#   machine-meta.json    display names; nothing else records them
#   usage-sessions.jsonl the who-used-which-machine ledger behind analytics
#   usage-open.json      live-session checkpoints
#   caddy/               the internal CA + its private key; losing it invalidates
#                        trust on every client device that imported the root cert
# A glob is deliberately NOT used: this list is explicit so a new stateful file
# has to be considered here rather than silently swept in (or silently missed).
BACKUP_FILES=""
for f in users.json sessions.json machines.json config.json usage.json \
         metrics.json alerts.jsonl audit.jsonl machine-meta.json \
         usage-sessions.jsonl usage-open.json browser-sessions.json secret; do
  [ -e "$DATA_DIR/$f" ] && BACKUP_FILES="$BACKUP_FILES $f"
done
# The Caddy directory holds the internal CA; include it when present.
[ -d "$DATA_DIR/caddy" ] && BACKUP_FILES="$BACKUP_FILES caddy"
[ -n "$BACKUP_FILES" ] || { log "ERROR nothing to back up in $DATA_DIR"; exit 1; }
# shellcheck disable=SC2086
tar -czf "$OUT" -C "$DATA_DIR" $BACKUP_FILES 2>/dev/null || { log "ERROR tar failed"; exit 1; }

chmod 600 "$OUT" 2>/dev/null || true
# Verify the archive is readable/intact before pruning older good copies.
if ! tar -tzf "$OUT" >/dev/null 2>&1; then log "ERROR archive verify failed: $OUT"; rm -f "$OUT"; exit 1; fi
# Record success so the panel can alert if backups go stale (deriveAlerts).
touch "$DATA_DIR/last-backup" 2>/dev/null || true
log "wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Retention: keep the newest $KEEP archives. Pruning runs only after the verify
# above succeeded, so a corrupt new archive never evicts a good older one.
if [ "$(ls -1t "$BACKUP_DIR"/vm-panel-data_*.tar.gz 2>/dev/null | wc -l | tr -d ' ')" -gt "$KEEP" ]; then
  ls -1t "$BACKUP_DIR"/vm-panel-data_*.tar.gz | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old" && log "pruned $old"; done
fi
# Count AFTER pruning — this previously reported the pre-prune total, so the log
# always claimed one more archive than was actually kept.
log "retained $(ls -1 "$BACKUP_DIR"/vm-panel-data_*.tar.gz 2>/dev/null | wc -l | tr -d ' ') archive(s), limit $KEEP"

# Off-host warning. The default backup directory sits on the SAME volume as the
# data it protects, so a disk or instance loss takes both. This is the single
# largest gap between "we take backups" and "we can recover".
case "$BACKUP_DIR" in
  "$DATA_DIR"*|"$HOME"/vm-panel-backups*|/opt/vm-panel/backups*)
    log "WARNING backup dir is on the same host/volume as the data — set VMP_BACKUP_DIR to off-host storage (separate volume, S3/rclone remote) for real disaster recovery" ;;
esac
log "done"
