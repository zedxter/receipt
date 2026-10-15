# IDD brief

Issue: https://github.com/zedxter/receipt/issues/3

## Intent
Stop unintended OpenRouter spending and route Receipt generation through the same Nous Portal access already used by pizdato.

## Evidence
`/etc/cron.d/receipt-channel` runs at 06:00 Europe/Berlin. Deployed `lib/openrouter.js` hardcodes the OpenRouter chat endpoint and DeepSeek 3.2. Logs confirm this route; the Cursor env toggle has no effect.

The canonical Receipt checkout contains uncommitted deployed changes. Preserve them; implement in a worktree and explicitly reconcile their behavior rather than copying the entire dirty checkout.

## Immediate containment
On 2026-10-15 the project OpenRouter key was removed from `~/.config/receipt-channel.env`, with a private backup outside Git. A generation probe with network interception and a copied database failed before the change (one attempted provider call), then passed (zero calls and successful database fallback). No Telegram messages were sent. Fresh Nous generation is not yet implemented.

## Approval and delivery
Spec PR receives five reviews and owner approval before production implementation. Then failing tests, implementation PR, CI, QA and deployment. JavaScript tests exercise the JavaScript runner; there is no Rust generation module in Receipt.
