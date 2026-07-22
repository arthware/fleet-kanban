# External-issue correlation

**Importance:** medium  ·  **Lives in:** `src/core/external-issue.ts`, `src/core/api-contract.ts`

An optional link from a card to its source-of-record issue in Linear or GitHub.

## Domain model
`runtimeExternalIssueSchema` = `{provider: linear|github, key, url?, raw}`, one per card,
informational only. A parser recognizes Linear keys/URLs and GitHub `owner/repo#n`, bare `#n`, and
issue URLs, normalizing to a canonical key/url.

## Reuse / do-not-duplicate
- Relates to [Task card](task-card.md), [Auto-review / PR mode](auto-review-pr-mode.md).
- **Do not duplicate:** one parser/shape; distinct from `prUrl` (the card's own PR, not its source
  issue).
