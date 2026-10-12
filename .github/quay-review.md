# Quay v2 PR reviews

Reviews start after successful PR runs of `ci`.

`quay-review.yml` sends event identities to `/quay/v2/review-pr`. It has read-only GitHub permissions and never checks out PR code. Quay fetches GitHub evidence before accepting a request. The first review is full; later compatible revisions use the last published baseline. A changed base or configuration requires a new baseline.

Repository writers can request verification with `/review` or `/review verify`, and a fresh full review with `/review full`. The Actions form supports targeted/full requests. Quay checks the actual comment author or dispatch actor's repository permission. PR closure cancels pending work. Slack and CI share the durable queue; retries are deduplicated.

## Activation prerequisites

1. Use the repository's normal merge and release process. This workflow must reach the default branch (`main`) before its privileged triggers activate. This PR does not authorize a release.
2. Configure repository or organization Actions secrets `QUAY_REVIEW_URL` (the existing HTTPS Quay origin) and `QUAY_REVIEW_PR_TOKEN` (the existing canonical ingress bearer credential). Reuse existing values; do not put credentials in Git or rotate them for this change. Missing or unsafe configuration fails visibly.
3. Have the Quay operator enroll `InverterNetwork/brix-share` in the root-managed review-ingress policy, with an internal public Slack channel containing Quay, the numeric workflow IDs for `ci`, and the `Quay review` workflow ID for manual dispatch. New workflow IDs must be read from GitHub after registration; do not guess them. Ensure supervisor Actions/repository reads and reviewer App access include this repository.
4. Validate a real PR event, verify the resulting GitHub review is pinned to its head, and check a writer's `/review full` request. Confirm delivery retries do not duplicate reviews.

The company ingress is deployed, but this repository's enrollment and secret availability have not been verified. Existing CI/deployment jobs and branch protection rules are unchanged. There is no v1 fallback.
