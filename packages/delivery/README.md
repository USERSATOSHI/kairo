# `@kouro/delivery`

Provider-neutral review-bound delivery contracts. The package validates editable
commit and pull-request metadata, checksums proposals against their prepared
tree and artifacts, declares `PullRequestProvider`, and reconciles an existing
head/base pull request before creation.

The package owns no Git, HTTP, filesystem, credential, or persistence state.
