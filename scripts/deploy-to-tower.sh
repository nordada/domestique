#!/usr/bin/env bash
# Syncs the local repo to TOWER's Domestique appdata folder. Run from the
# repo root (or anywhere — path below is absolute). Excludes node_modules,
# dist, and .git (TOWER doesn't need a working git checkout, just the files).
#
# After this finishes, on TOWER: cd into the deployed folder and run
# `docker compose up -d` (add --build if source files changed, not just
# config) to pick up the changes.
set -euo pipefail

rsync -av \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '.claude' \
  ~/projects/domestique/ root@192.168.1.24:/mnt/user/appdata/domestique/
