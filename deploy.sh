#!/usr/bin/env bash
# Deploy a specific commit of VM Panel to a target directory, with a recorded
# build identity and a rollback path.
#
#   bash deploy.sh [--ref <git-ref>] [--target <dir>] [--restart <cmd>] [--dry-run]
#
# Why this exists: code previously reached the live tree by manual copy. There was
# no record of WHICH commit was deployed, and package.json has read "1.0.0" for
# every commit ever made — so a tree seven commits behind HEAD reported an
# identical version to HEAD and the drift was invisible. (That was the real state
# of production: a build six days old, missing crash-safety fixes, unnoticed.)
#
# What this guarantees:
#   * the deployed tree is an exact checkout of one commit (no partial copies)
#   * BUILD_INFO.json records the commit, branch, time and deployer, and the panel
#     surfaces it at /healthz, /readyz and /api/state
#   * the previous release is kept, so rollback is one command
#   * data/ is NEVER touched — it is the only stateful directory
#   * the test suite gates the deploy (use --skip-tests only with a reason)
set -euo pipefail

REF="HEAD"
TARGET="${VMP_TARGET:-/Users/mac/vm-panel}"
RESTART_CMD=""
DRY_RUN=0
SKIP_TESTS=0
KEEP_RELEASES=5

usage() { sed -n '2,20p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --target) TARGET="${2:?--target needs a value}"; shift 2 ;;
    --restart) RESTART_CMD="${2:?--restart needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "$REPO_DIR is not a git checkout" >&2; exit 1; }

SHA="$(git rev-parse "$REF")" || { echo "cannot resolve ref: $REF" >&2; exit 1; }
SHORT="$(git rev-parse --short=12 "$REF")"
BRANCH="$(git rev-parse --abbrev-ref "$REF" 2>/dev/null || echo detached)"

# Refuse to deploy a dirty tree unless deploying an explicit committed ref: what
# lands must be reproducible from the SHA recorded in BUILD_INFO.json.
if [ "$REF" = "HEAD" ] && [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree has uncommitted changes." >&2
  echo "       Commit them, or deploy a specific committed ref with --ref <sha>." >&2
  git status --short >&2
  exit 1
fi

NODE_BIN="${VMP_NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
[ -x "$NODE_BIN" ] || { echo "node not found (set VMP_NODE)" >&2; exit 1; }

echo "== VM Panel deploy =="
echo "  repo    : $REPO_DIR"
echo "  ref     : $REF -> $SHORT ($BRANCH)"
echo "  target  : $TARGET"
echo "  node    : $NODE_BIN"
[ "$DRY_RUN" = 1 ] && echo "  MODE    : dry run (nothing will be written)"

# ---- 1. Gate on the test suite -------------------------------------------------
if [ "$SKIP_TESTS" = 1 ]; then
  echo "[1/5] Tests SKIPPED by --skip-tests (untested code is about to be deployed)."
else
  echo "[1/5] Running the test suite (a real gate — a failure stops the deploy)…"
  if ! "$NODE_BIN" --test --test-timeout=120000 test/*.test.js > /tmp/vmp-deploy-tests.$$ 2>&1; then
    echo "ERROR: tests FAILED — refusing to deploy. Output:" >&2
    tail -40 /tmp/vmp-deploy-tests.$$ >&2
    rm -f /tmp/vmp-deploy-tests.$$
    exit 1
  fi
  echo "      $(grep -E '^# (pass|tests)' /tmp/vmp-deploy-tests.$$ 2>/dev/null | tr '\n' ' ' || echo 'tests green')"
  rm -f /tmp/vmp-deploy-tests.$$
fi

# ---- 2. Export the commit to a staging dir -------------------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_DIR="${TARGET}.releases/${STAMP}-${SHORT}"
echo "[2/5] Exporting $SHORT to $RELEASE_DIR…"
if [ "$DRY_RUN" = 0 ]; then
  mkdir -p "$(dirname "$RELEASE_DIR")" "$RELEASE_DIR"
  # git archive gives a clean tree of exactly this commit — no stray files, no
  # partially-copied working tree.
  git archive "$SHA" | tar -x -C "$RELEASE_DIR"
  cat > "$RELEASE_DIR/BUILD_INFO.json" <<JSON
{
  "sha": "$SHA",
  "shortSha": "$SHORT",
  "branch": "$BRANCH",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "deployedBy": "$(id -un)@$(hostname -s)",
  "testsGated": $([ "$SKIP_TESTS" = 1 ] && echo false || echo true)
}
JSON
fi

# ---- 3. Carry over the stateful directory --------------------------------------
# data/ holds users, sessions, the signing secret and config. It is the ONLY thing
# that must survive a deploy, and it must never be overwritten by the release.
echo "[3/5] Linking data/ (state is never replaced by a deploy)…"
if [ "$DRY_RUN" = 0 ]; then
  if [ -d "$TARGET/data" ]; then
    mv "$TARGET/data" "$RELEASE_DIR/data"
    echo "      moved existing data/ into the new release"
  else
    mkdir -p "$RELEASE_DIR/data"; chmod 700 "$RELEASE_DIR/data"
    echo "      fresh data/ created (first deploy)"
  fi
fi

# ---- 4. Swap the release into place -------------------------------------------
echo "[4/5] Activating the release (previous kept for rollback)…"
if [ "$DRY_RUN" = 0 ]; then
  if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
    PREV="${TARGET}.previous"
    rm -rf "$PREV"
    mv "$TARGET" "$PREV"
    echo "      previous release -> $PREV"
  elif [ -L "$TARGET" ]; then
    rm -f "$TARGET"
  fi
  mv "$RELEASE_DIR" "$TARGET"
  # Prune old releases, keeping the most recent few.
  if [ -d "${TARGET}.releases" ]; then
    # shellcheck disable=SC2012
    ls -1dt "${TARGET}.releases"/* 2>/dev/null | tail -n "+$((KEEP_RELEASES + 1))" | while read -r old; do
      rm -rf "$old"
    done
  fi
fi

# ---- 5. Restart + verify -------------------------------------------------------
echo "[5/5] Restart + verify…"
if [ "$DRY_RUN" = 1 ]; then
  echo "      (dry run — skipping restart)"
  echo "DEPLOY_DRY_RUN_OK $SHORT"
  exit 0
fi

if [ -n "$RESTART_CMD" ]; then
  echo "      $RESTART_CMD"
  sh -c "$RESTART_CMD" || { echo "WARN: restart command failed — the panel may still be running the old build" >&2; }
else
  echo "      no --restart given; restart the service yourself, e.g.:"
  echo "        launchctl kickstart -k gui/\$(id -u)/com.vmpanel     # macOS"
  echo "        sudo systemctl restart vm-panel                     # Linux"
fi

# Verify the RUNNING build matches what we just deployed. This is the check that
# would have caught the seven-commit drift.
PORT="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$TARGET/data/config.json" 2>/dev/null | head -1)"
PORT="${PORT:-5050}"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  LIVE="$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)"
  case "$LIVE" in
    *"$SHORT"*)
      echo "DEPLOY_OK commit=$SHORT — verified live on :$PORT"
      exit 0 ;;
  esac
done
echo "DEPLOY_UNVERIFIED commit=$SHORT — deployed, but /healthz on :$PORT did not report this build." >&2
echo "  Check the service started, then: curl -s http://127.0.0.1:${PORT}/healthz" >&2
echo "  Roll back with: rm -rf '$TARGET' && mv '${TARGET}.previous' '$TARGET' && <restart>" >&2
exit 2
