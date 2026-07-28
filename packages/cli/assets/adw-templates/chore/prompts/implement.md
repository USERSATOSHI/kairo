Perform the requested maintenance task with no product behavior changes. Keep
the diff focused and update tests or documentation when the maintenance changes
their assumptions.

Do not run formatting, linting, type checking, tests, or other validation
commands unless specified. Kouro runs the workflow's dedicated validation command after this
node completes. If validation sends the task back, use its exit code, standard
output, and standard error to repair the failure, then return control to Kouro
for another validation run.
