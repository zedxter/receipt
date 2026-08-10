#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${SUDO_ASKPASS:-}" ]]; then
  sudo() { command sudo -A "$@"; }
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/deploy/channel"
DEST=/opt/receipt/channel

DEPLOY_USER="${RECEIPT_DEPLOY_USER:-${SUDO_USER:-}}"
if [[ -z "$DEPLOY_USER" || "$DEPLOY_USER" == "root" ]]; then
  echo "Set RECEIPT_DEPLOY_USER to the login that owns the Telegram session." >&2
  exit 1
fi
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
if [[ -z "$DEPLOY_HOME" ]]; then
  echo "Unknown user: $DEPLOY_USER" >&2
  exit 1
fi
NODE_BIN="$(sudo -u "$DEPLOY_USER" bash -lc 'command -v node' || true)"
# Prefer the same Node used by Cursor / mcp-telegram when login shell PATH is thin.
if [[ -x "$DEPLOY_HOME/.local/node/bin/node" ]]; then
  NODE_BIN="$DEPLOY_HOME/.local/node/bin/node"
elif [[ -z "$NODE_BIN" ]]; then
  echo "node not found for user $DEPLOY_USER" >&2
  exit 1
fi

ENV_EXAMPLE="$SRC/receipt-channel.env.example"
ENV_FILE="$DEPLOY_HOME/.config/receipt-channel.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Creating $ENV_FILE from example"
  sudo -u "$DEPLOY_USER" mkdir -p "$DEPLOY_HOME/.config"
  sudo -u "$DEPLOY_USER" cp "$ENV_EXAMPLE" "$ENV_FILE"
  sudo -u "$DEPLOY_USER" chmod 600 "$ENV_FILE"
fi

echo "==> Installing receipt morning poster (user=$DEPLOY_USER)"
sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEST"
sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" /var/lib/receipt
sudo find "$DEST" -mindepth 1 -delete
sudo cp -a "$SRC"/. "$DEST"/
sudo rm -rf "$DEST/node_modules"
sudo chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEST"
sudo -u "$DEPLOY_USER" bash -lc "export PATH=\"$(dirname "$NODE_BIN"):\$PATH\"; cd '$DEST' && npm ci --omit=dev"

sudo tee /etc/cron.d/receipt-channel >/dev/null <<EOF
# Daily recipe post to «Рецепты на каждый день» (server TZ: Europe/Berlin)
SHELL=/bin/bash
PATH=$(dirname "$NODE_BIN"):$DEPLOY_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
MAILTO=""

# Morning recipe + photo at 07:00
0 7 * * * $DEPLOY_USER cd $DEST && $NODE_BIN post-daily.mjs >> /var/log/receipt-channel.log 2>&1
EOF
sudo chmod 644 /etc/cron.d/receipt-channel

sudo touch /var/log/receipt-channel.log
sudo chown "$DEPLOY_USER:$DEPLOY_USER" /var/log/receipt-channel.log

# Ensure history path is writable
sudo -u "$DEPLOY_USER" bash -lc "mkdir -p '$DEPLOY_HOME/.local/share/receipt' /var/lib/receipt"

echo "==> Receipt poster installed"
echo "    Channel peer: \$RECEIPT_CHANNEL in $ENV_FILE"
echo "    Cron: 07:00 Europe/Berlin → $DEST/post-daily.mjs"
echo "    Manual: cd $DEST && node post-daily.mjs [--preview|--dry-run]"
echo "    Log: /var/log/receipt-channel.log"
echo "    Secrets: $DEPLOY_HOME/.config/telegram-mcp.env + $ENV_FILE"
