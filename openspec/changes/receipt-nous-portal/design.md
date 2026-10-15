## Context
The deployed Receipt generator uses OpenRouter's Exa web plugin to discover recipes. Merely swapping the endpoint loses search and can yield invented URLs. Pizdato already has a fixed-host Nous client with bounded requests and safe errors that provides a useful implementation reference.

## Goals / Non-Goals
Goals: Nous-only generation, real source provenance, no secret leakage, maintained recipe constraints and fallback.
Non-goals: changing cron timing, Telegram publishing, image generation, or other projects' providers.

## Decisions
1. Use a fixed HTTPS Nous Portal chat-completions endpoint, `NOUS_API_KEY`, and an explicit OpenAI model default `openai/gpt-6.1-sol`. Do not accept OpenRouter fallback or generic endpoint overrides. Reject stale DeepSeek/OpenRouter model configuration. Use reasoning effort instead of temperature for the selected reasoning model.
2. Keep source discovery separate from model generation. Start with recipe source URLs already held in the recipe database, excluding recent titles. Fetch a bounded public HTTPS source page and provide its extracted recipe text to the model for adaptation. Source and image URLs are anchored to the fetched page, never trusted solely from model output. This initial migration does not add a new search provider or subscription; expanding discovery can follow separately.
3. Retain recipe validation, pork exclusion, variety checks, source-image resolution and database fallback. Provider failure never invokes another model provider. If no suitable source or fallback exists, fail visibly without posting.
4. Load the existing Nous credential only into Receipt's private env. Remove obsolete OpenRouter and Cursor settings from that project's active configuration and examples. Never put keys in reports or Git.
5. Test through `generateRecipe` and the outbound HTTP boundary with an isolated DB. Cover provider routing despite inherited OpenRouter credentials, source grounding, malformed/truncated responses, deadlines, missing credentials, dietary checks and fallback. Live smoke tests must use a copied DB and must not send Telegram messages.

## Risks / Trade-offs
Initial source discovery is limited to the existing database source corpus. Fetch failures can reduce diversity; fallback must remain visible. Existing dirty changes require careful reconciliation. Older deployment directories may retain historical provider code but must not be referenced by any enabled scheduler or unit.

## Migration Plan
Contain OpenRouter calls first (completed). After spec approval, implement and verify; deploy the reviewed runner and private credential configuration; smoke-test generation and inspect the next scheduled execution. Rollback keeps OpenRouter disabled and uses database fallback rather than restoring the removed key.
