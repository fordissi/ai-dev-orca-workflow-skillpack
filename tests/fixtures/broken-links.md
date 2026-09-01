# Broken link fixture

This file exists to prove the Markdown link checker rejects repository-relative
links that do not resolve. It is expected to be invalid and is exempted from the
repository link check by an explicit entry in the validator.

A link that does not resolve: [missing policy](policies/DOES_NOT_EXIST.md)
Another one, one directory up: [missing template](../templates/NOT_HERE.md)

These must still be accepted, and are here to prove the checker is not simply
reporting everything:

- an external URL: [GitHub CLI manual](https://cli.github.com/manual/)
- a bare anchor: [top](#broken-link-fixture)
- a real repository file: [workflow policy](../../policies/WORKFLOW_POLICY.md)
