#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo 'Usage: run_monthly_report.sh YYYY-MM-DD YYYY-MM-DD [OUTPUT_DIR]' >&2
  exit 2
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPORT_OUTPUT="${3:-/Users/chacha/src/youtube-describer/prod_report}"
# Always recollect; never reuse an earlier month's or an older collector's raw report.
node "$SCRIPT_DIR/stats_collector.js" "$1" "$2" --output-dir "$REPORT_OUTPUT"
python3 "$SCRIPT_DIR/build_monthly_report.py" "$1" "$2" --output-dir "$REPORT_OUTPUT"
