Perform the requested maintenance task without changing product behavior.

Keep the diff focused:

* Make only the changes required for the task.
* Do not perform unrelated refactors, cleanups, dependency updates, or formatting changes.
* Preserve existing public APIs and runtime behavior unless the task explicitly requires otherwise.
* Update existing tests or documentation only when the maintenance change invalidates their current assumptions.

Do not run formatting, linting, type checking, tests, builds, or other validation commands unless the task explicitly asks you to do so. Kouro will run the workflow's dedicated validation command after this node completes.

When the implementation is complete, summarize the changes and stop.

If Kouro returns the task after validation fails, use the provided exit code, standard output, and standard error to identify and repair only the reported failure. Do not run the validation command yourself. After applying the repair, summarize the change and stop so Kouro can validate again.
