# receipt

Daily Telegram channel poster: healthy family dinner recipes (Germany — Rewe / Penny / Lidl).

## What it does

Every morning at **06:00** (Europe/Berlin) a cron job:

1. Fetches a real recipe from REWE / BBC Good Food discovery or previously saved supported sources and adapts it through Nous Portal (`openai/gpt-6.1-sol`) — **no pork**; Russian & Italian welcome (Rewe/Penny/Lidl only); soups/grains ok; rotates proteins so it is not chicken every day
2. Saves the recipe to a local SQLite DB
3. Downloads the dish photo from the recipe source (no AI image generation)
4. Posts **one** Telegram message: photo + caption (incl. source link)

The generator extracts recipe ingredients, steps and the dish image from source-page JSON-LD. Model-generated URLs are replaced with the fetched source URLs. Nous is the only model provider; inherited OpenRouter, Groq or OpenAI API keys are ignored.

If source retrieval/LLM fails, a random recipe with a source image is taken from the DB.

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
# fill NOUS_API_KEY, TELEGRAM_ACCOUNT_ID, RECEIPT_CHANNEL, session paths
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

## Validation

Run `npm ci && npm test` in `deploy/channel` (Node 20). Tests use an isolated database and intercept HTTP; they never publish to Telegram.

`--dry-run` generates and saves recipes, but does not publish. For migration checks, set `RECEIPT_DB` to a copy of the production database. Keep private credentials in env files with mode 0600. Remove obsolete OpenRouter and Cursor settings from the Receipt env when deploying. A rollback must keep OpenRouter disabled and use database fallback.
