#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
command -v node >/dev/null || { echo '需要 Node.js 22+' >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22)process.exit(1)' || { echo '需要 Node.js 22+' >&2; exit 1; }
if [[ ! -f config/config.json ]]; then
  cp config/config.example.json config/config.json
  chmod 600 config/config.json
  echo '已生成 config/config.json；填写密钥和凭据后重试。' >&2
  exit 2
fi
exec node src/server.mjs
