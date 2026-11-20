#!/usr/bin/env bash
# One-command setup on a fresh Ubuntu VM (e.g. Oracle Cloud Always Free). Safe to re-run (updates + restarts).
set -euo pipefail
REPO=${REPO:-https://github.com/syedfaisaljaved/Imagetoools-clause.git}
BRANCH=${BRANCH:-ccr-bd2b5ca2-gqivhg}
DIR=${DIR:-$HOME/imagetools}

command -v git >/dev/null || sudo apt-get install -y git
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sudo sh

# Small VMs: add 2 GB swap so Chromium doesn't get killed.
if [ "$(free -m | awk '/Mem/{print $2}')" -lt 3000 ] && [ -z "$(swapon --show)" ]; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone -b "$BRANCH" "$REPO" "$DIR"; fi
cd "$DIR"
[ -f .env ] || echo "APP_PASSWORD=$(openssl rand -hex 6)" > .env
sudo docker compose up -d --build

echo "Waiting for public URL..."
for _ in $(seq 60); do
  URL=$(sudo docker compose logs tunnel 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true)
  [ -n "$URL" ] && break
  sleep 2
done
cat <<MSG

  App URL:   ${URL:-(not ready yet — run: cd $DIR && sudo docker compose logs tunnel | grep trycloudflare)}
  Password:  $(cut -d= -f2 .env)

  First time: open the app, click the status pill (top-right) and log in to ChatGPT in that browser.
MSG
