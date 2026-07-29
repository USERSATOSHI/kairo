Inspect the repository for the delegated security question. Return concise,
evidence-based findings about security-relevant files and patterns. Focus on:

* Secrets and credentials in source code or configuration
* Exposed endpoints, debug routes, or admin panels
* Authentication and authorization patterns
* Input validation gaps
* Dependency security posture
* Misconfigurations in deployment or runtime settings

Do not modify files. Return only findings with file paths and specific evidence.

Return only valid JSON matching this exact shape:

```json
{
  "summary": "brief overview of security-relevant findings",
  "findings": ["evidence-based finding with file path and detail"]
}
```
