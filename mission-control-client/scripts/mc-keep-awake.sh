#!/usr/bin/env bash
# Prevent macOS system sleep while the edge client runs (display may still turn off).
# Linux/Windows server: no-op unless you use systemd inhibitors separately.
#
# MC_KEEP_AWAKE=1 (default) — block idle/system sleep via caffeinate
# MC_KEEP_AWAKE=0 — do not interfere with OS power management

mc_keep_awake_enabled() {
  if [[ "${MC_KEEP_AWAKE:-0}" == "0" ]]; then
    return 1
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 1
  fi
  command -v caffeinate >/dev/null 2>&1
}

mc_exec_keep_awake() {
  if mc_keep_awake_enabled; then
    echo "==> keep-awake: blocking system sleep while edge runs (display may turn off; set MC_KEEP_AWAKE=0 to disable)"
    # -i idle, -m disk, -s system (AC), -u user active (battery); omit -d so display can sleep
    exec caffeinate -imsu "$@"
  fi
  exec "$@"
}
