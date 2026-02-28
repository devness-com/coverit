#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEBSITE_DIR="$(dirname "$SCRIPT_DIR")"
SERVER="root@142.132.177.207"

echo "Building website..."
cd "$WEBSITE_DIR"
bun run build

echo "Building Docker image..."
cp -r dist "$SCRIPT_DIR/dist"
docker build --platform linux/amd64 -t coverit-web:latest "$SCRIPT_DIR"
rm -rf "$SCRIPT_DIR/dist"

echo "Deploying to server..."
docker save coverit-web:latest | ssh "$SERVER" "k3s ctr images import -"
ssh "$SERVER" "k3s kubectl rollout restart deployment/web -n coverit && k3s kubectl rollout status deployment/web -n coverit --timeout=120s"

echo "Done! https://coverit.dev is updated."
