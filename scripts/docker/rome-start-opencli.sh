#!/usr/bin/env bash
set -euo pipefail

if ! command -v opencli >/dev/null 2>&1; then
  echo "OpenCLI is not installed." >&2
  exit 1
fi

if curl --fail --silent --max-time 2 http://127.0.0.1:19825/ping >/dev/null; then
  exit 0
fi

opencli daemon restart
