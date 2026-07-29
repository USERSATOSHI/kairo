Read the validated change without modifying any files.

Based on the actual validated diff, propose:

* A concise commit title.
* An optional commit body.
* A concise pull-request title.
* An optional pull-request body.
* Whether the pull request should be opened as a draft.

Use the repository's existing commit-title conventions when they can be determined from the available context. Do not invent changes that are not present in the validated diff.

Return only valid JSON matching the exact shape below. Do not include Markdown fences, commentary, or additional fields. Use an empty string when a body is unnecessary.

```json
{
  "deliveryMetadata": {
  "commitTitle": "feat: concise commit title",
  "commitBody": "",
  "pullRequestTitle": "feat: concise pull-request title",
  "pullRequestBody": "",
  "draft": false
  }
}
```
