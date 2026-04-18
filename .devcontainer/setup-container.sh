#!/usr/bin/env bash
set -euo pipefail

# Fix named-volume ownership so the remoteUser can write into mounted config
# directories. Authentication itself is manual — run `claude login`,
# `gh auth login`, etc. inside the container terminal after first start.
for dir in "$HOME/.claude" /commandhistory; do
  if [ -d "$dir" ] && [ ! -w "$dir" ]; then
    sudo chown -R "$(id -un):$(id -gn)" "$dir"
  fi
done
