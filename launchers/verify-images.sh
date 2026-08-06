#!/usr/bin/env bash
# Verify that every image the panel's templates reference actually matches what the
# code expects, BEFORE users hit it.
#
# Why this exists: the Dockerfiles were rewritten from noVNC to KasmVNC (which
# serves on 6901 over TLS with Basic auth) but the tagged images were never
# rebuilt. They kept serving plain noVNC on 6080, so the panel could not proxy
# them at all — every desktop was unopenable, and nothing surfaced it. Both
# desktop images had drifted this way.
#
# Run after any image rebuild, and as a post-deploy check:
#   bash launchers/verify-images.sh
# Exit 0 = every template's image is consistent with the code. Non-zero = drift.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
DOCKER="${VMP_DOCKER:-docker}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

fail=0
note() { printf '  %s\n' "$1"; }

# Ask the app itself which image + UI port each template declares, so this check
# can never drift from the code it is checking.
MAP="$("${VMP_NODE:-node}" -e '
import("'"$HERE"'/lib/core.js").then(({ TEMPLATES }) => {
  for (const t of Object.values(TEMPLATES)) {
    const ui = t.ports.find((p) => p.role === "ui");
    console.log([t.id, t.image, ui.containerPort, t.backendTls ? "tls" : "plain"].join("\t"));
  }
});' 2>/dev/null)"

[ -n "$MAP" ] || { echo "ERROR: could not read templates from lib/core.js"; exit 1; }

echo "== Template image verification =="
while IFS=$'\t' read -r id image port scheme; do
  [ -n "$id" ] || continue
  printf '%-16s %s\n' "$id" "$image"
  if ! "$DOCKER" image inspect "$image" >/dev/null 2>&1; then
    note "MISSING — image not present locally. Build or pull it."
    fail=1; continue
  fi
  # ExposedPorts is only AUTHORITATIVE for images we build ourselves, because our
  # Dockerfiles declare EXPOSE. Docker happily publishes a port that was never
  # EXPOSEd, so a third-party image (the pulled seleniarm nodes serve noVNC on
  # 7900 without declaring it) must not be failed on metadata alone — that would
  # be a false alarm, and a checker that cries wolf gets ignored.
  ctx=""
  case "$image" in
    minimal-linux-desktop:xfce*)  ctx="$HERE/images/linux-desktop" ;;
    minimal-linux-desktop:icewm*) ctx="$HERE/images/icewm-desktop" ;;
  esac
  exposed="$("$DOCKER" image inspect "$image" --format '{{range $p,$v := .Config.ExposedPorts}}{{$p}} {{end}}' 2>/dev/null)"
  case "$exposed" in
    *"${port}/tcp"*) note "ok    exposes ${port}/tcp as the code expects" ;;
    *)
      if [ -n "$ctx" ]; then
        note "DRIFT exposes [${exposed% }] but the panel proxies to ${port} — desktops will NOT open."
        note "      Rebuild: docker build -t $image $ctx"
        fail=1
      else
        note "info  does not declare ${port}/tcp, but this is a third-party image we"
        note "      only pull — EXPOSE metadata is not authoritative for it. Confirm at"
        note "      runtime: docker port <container> (expect ${port}/tcp published)."
      fi ;;
  esac
  # A healthcheck is what makes a wedged desktop visible as `unhealthy` instead of
  # silently broken; the panel raises an alert on it.
  if [ "$("$DOCKER" image inspect "$image" --format '{{if .Config.Healthcheck}}yes{{else}}no{{end}}' 2>/dev/null)" != "yes" ]; then
    note "warn  no HEALTHCHECK — a wedged desktop cannot be detected or alerted on"
  fi
  # Passwordless sudo turns any in-desktop code execution into container root, and
  # container root is VM root without userns-remap.
  if "$DOCKER" run --rm --entrypoint sh "$image" -c 'ls /etc/sudoers.d/ 2>/dev/null' 2>/dev/null | grep -qvE '^(README)?$'; then
    note "warn  /etc/sudoers.d is non-empty — check for blanket NOPASSWD sudo"
  fi
done <<< "$MAP"

echo
if [ "$fail" -eq 0 ]; then
  echo "IMAGES_OK — every template image matches the code."
else
  echo "IMAGES_DRIFT — at least one image does not match the code. Desktops using it cannot be proxied."
fi
exit "$fail"
