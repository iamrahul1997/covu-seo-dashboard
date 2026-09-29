#!/bin/bash
# Install (or remove) the nightly refresh as a launchd user agent.
#
#   ./ops/install-schedule.sh            install and start
#   ./ops/install-schedule.sh --remove   stop and uninstall
#   ./ops/install-schedule.sh --status    show whether it is loaded
#
# This is a user agent, not a system daemon: it needs no password, runs only as
# you, and touches nothing outside your home directory.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.covu.search-platform.refresh"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

case "${1:-install}" in
  --remove)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$TARGET"
    echo "removed $LABEL"
    ;;
  --status)
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
      echo "$LABEL is loaded"
      launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|last exit|runs" || true
    else
      echo "$LABEL is not loaded"
    fi
    ;;
  install)
    mkdir -p "$HOME/Library/LaunchAgents"
    sed "s|__REPO__|$REPO|g" "$REPO/ops/com.covu.search-platform.refresh.plist" > "$TARGET"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$TARGET"
    echo "installed $LABEL — runs daily at 06:30, logging to $REPO/ops/refresh.log"
    echo "run it now with:  launchctl kickstart gui/$(id -u)/$LABEL"
    ;;
  *)
    echo "usage: $0 [install|--remove|--status]" >&2; exit 1 ;;
esac
