## 1. Review
- [ ] 1.1 Obtain five spec reviews and owner approval on the spec PR.
- [ ] 1.2 Reconcile deployed behavior and canonical dirty changes in an implementation worktree.

## 2. Implementation (TDD)
- [ ] 2.1 Add a failing generation-boundary test proving Nous-only routing even with inherited OpenRouter credentials; implement the fixed-host client.
- [ ] 2.2 Add failing source-grounding tests; implement bounded recipe-page retrieval from non-recent database sources.
- [ ] 2.3 Cover timeouts, malformed responses, missing credentials, model validation, secret-safe errors and database fallback.
- [ ] 2.4 Verify dietary, variety, caption and image behavior; update env examples and deployment docs.

## 3. Delivery
- [ ] 3.1 Open the implementation PR referencing #3 and pass CI and QA.
- [ ] 3.2 Deploy reviewed code and private Nous configuration while keeping OpenRouter disabled.
- [ ] 3.3 Run non-publishing generation with a copied DB; verify Nous host/model and source provenance.
- [ ] 3.4 Inspect the next scheduled run, audit active cron/unit configurations and archive the change.
