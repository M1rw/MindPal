# MindPal response-quality prompt-contract benchmark

| Scenario | Tier | Baseline requires visible thought | Revised requires visible thought | CLEAR contract present | Private-reasoning guard present |
|---|---|---:|---:|---:|---:|
| Casual support | casual | yes | no | yes | yes |
| Emotional support | emotional | yes | no | yes | yes |
| Clinical support | clinical | yes | no | yes | yes |
| Egyptian Arabic | emotional | yes | no | yes | yes |

| Metric | Baseline | Revised |
|---|---:|---:|
| Prompt tiers requiring a visible thought block | 4/4 | 0/4 |
| Scenarios with the CLEAR response contract | 0/4 | 4/4 |
| Scenarios with an explicit private-reasoning guard | 0/4 | 4/4 |

| Finalizer smoke check | Before | After |
|---|---|---|
| Legacy two-block output | `**Thought:** private plan

**Response:** A grounded, user-visible response.` | `A grounded, user-visible response.` |
