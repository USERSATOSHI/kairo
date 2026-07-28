Read the validated change without modifying files. Propose concise commit and
pull-request titles, optional bodies, and whether the pull request should be a
draft. Return only this JSON shape, using these exact field names:

```json
{
  "deliveryMetadata": {
    "commitTitle": "feat: concise commit title",
    "commitBody": "Optional commit body.",
    "pullRequestTitle": "feat: concise pull-request title",
    "pullRequestBody": "Optional pull-request body.",
    "draft": false
  }
}
```
