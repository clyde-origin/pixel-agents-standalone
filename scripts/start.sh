#!/usr/bin/env bash
# Build the latest UI + server bundle and start the server.
# Invoked by ~/Library/LaunchAgents/com.pixel-agents.server.plist on login.
set -euo pipefail

cd "$(dirname "$0")/.."

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

npm run build
exec node dist/server.js
