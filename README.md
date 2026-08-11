# receipt

Daily Telegram channel poster: healthy family dinner recipes (Germany — Rewe / Penny / Lidl).

## What it does

Every morning at **07:00** (Europe/Berlin) a cron job:

1. Searches the web for one balanced family dinner (via `cursor-agent`) — **no pork**; Russian & Italian welcome (Rewe/Penny/Lidl only); soups/grains ok; rotates proteins so it is not chicken every day
2. Saves the recipe to a local SQLite DB
3. Downloads the dish photo from the recipe source (no AI image generation)
4. Posts **one** Telegram message: photo + caption (incl. source link)

If search/LLM fails, a random recipe with a source image is taken from the DB.

## Layout

```
deploy/
  install-channel.sh          # install to /opt/receipt/channel + cron
  channel/
    post-daily.mjs            # entrypoint
    lib/                      # generate, image, db, telegram
    receipt-channel.env.example
assets/                       # optional local images (e.g. channel avatar)
```

## Setup

1. Telegram user session via [mcp-telegram](https://github.com/beautyfree/mcp-telegram) (`TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from https://my.telegram.org/apps).
2. Copy env example:

```bash
cp deploy/channel/receipt-channel.env.example ~/.config/receipt-channel.env
chmod 600 ~/.config/receipt-channel.env
# fill TELEGRAM_ACCOUNT_ID, RECEIPT_CHANNEL, session paths
```

3. Install (as the user that owns the Telegram session):

```bash
RECEIPT_DEPLOY_USER="$USER" ./deploy/install-channel.sh
```

4. Manual run:

```bash
cd /opt/receipt/channel
node post-daily.mjs --dry-run
node post-daily.mjs --preview
node post-daily.mjs
```

Secrets stay in `~/.config/` and are **not** committed. Do not commit Telegram session dirs (`~/.telegram-agent/`).
