#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/var/www/st24}"
API_URL="${2:-https://xn---24-3edf.xn--p1ai}"
SERVICE_NAME="${3:-her-api}"

echo "Deploying from: ${ROOT}"
echo "API URL: ${API_URL}"
echo "Service: ${SERVICE_NAME}"

cd "${ROOT}"

echo "==> git pull"
git pull

echo "==> npm install (root)"
npm install

echo "==> build client"
(cd client && VITE_API_URL="${API_URL}" npm run build)

echo "==> build server"
(cd server && npm run build)

echo "==> restart service"
sudo systemctl restart "${SERVICE_NAME}"
sudo systemctl status --no-pager "${SERVICE_NAME}"
