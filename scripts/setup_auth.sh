#!/usr/bin/env bash
# Shared auth setup sourced by entrypoint.sh and code_server.sh.
# Requires: GITHUB_TOKEN, GITHUB_USERNAME
set -euo pipefail

git config --global user.name  "${GIT_AUTHOR_NAME:-Agent}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-agent@localhost}"

git config --global credential.helper store
printf 'https://%s:%s@github.com\n' "$GITHUB_USERNAME" "$GITHUB_TOKEN" \
    > /home/agent/.git-credentials

git config --global --add safe.directory '*'
