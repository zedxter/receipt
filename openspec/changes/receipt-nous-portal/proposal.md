## Why
Receipt's deployed daily job still calls OpenRouter DeepSeek 3.2. The owner confirmed that the intended destination is the existing Nous Portal with OpenAI models. This change addresses #3.

## What Changes
- Replace all Receipt model generation routes with Nous Portal and `openai/gpt-6.1-sol`.
- Remove OpenRouter credentials, SDK assumptions, model defaults and web plugins from active configuration and supported runtime paths.
- Obtain real recipe source material independently of the model provider.
- Preserve dietary checks, variety, real source images and database fallback.

## Capabilities
### New Capabilities
- `recipe-generation`: Nous-only generation from verified recipe source material.

## Impact
Receipt channel JavaScript, runtime env, deployment documentation and tests. No changes to Telegram destination or cron schedule. Existing pizdato active jobs already use Nous Portal.
