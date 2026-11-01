# Quay reviews

`Quay Review` requests a review after the entire `ci` workflow succeeds for a pull request. CI covers PRs targeting any branch. Failed or cancelled CI and push CI do not request reviews. Draft PRs use the same request path.

The GitHub Apps need repository access and the organization Actions secrets `QUAY_REVIEW_URL` and `QUAY_REVIEW_PR_TOKEN` must be available. The submission workflow has read-only GitHub permissions, never checks out PR code and forwards source run and PR identities. Quay handles authorization, eligibility, superseded revisions and deduplication.

Use `/review` or `/review verify` for verification, `/review full` for a fresh review. Commands accept case and whitespace variations. The Actions form supports targeted/full requests and must run from the default branch; the target PR can use any branch. These requests do not wait for CI and explicit rejections fail visibly. Closing a PR sends cancellation.

GitHub lookup and Quay submission use up to four attempts for transient HTTP and connection failures, reject redirects and sanitize errors. HTTP 422 is benign only for automatic and closure requests.

Run `python3 -m unittest discover -s test-quay -v` with Python 3 and Node installed. All 32 tests execute the embedded Python and outer job condition with fixture identities and mocked HTTP. The `Quay review regression tests` job runs in normal CI before automatic submission is eligible.

The workflow activates when it reaches the default branch through the normal merge/promotion process. No application or AWS deployment is needed. After activation, verify a successful PR CI event produces a review for the intended revision, failed/push CI produces none and commands, manual requests and closure work. A green workflow or queued response proves submission only, not completed review delivery.

Baseline: [infra PR #48](https://github.com/InverterNetwork/infra/pull/48).
