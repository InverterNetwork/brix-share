import contextlib
import copy
import http.client
import io
import json
import os
import re
import subprocess
from pathlib import Path
import tempfile
import textwrap
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/quay-review.yml').read_text()
SCRIPT = textwrap.dedent(WORKFLOW.split("python3 - <<'PY'\n", 1)[1]).rsplit('\nPY', 1)[0]
# Deliberately independent of the repository hosting this workflow.
REPOSITORY = 'InverterNetwork/workflow-fixture'
RUN = {
    'repository': {'full_name': REPOSITORY, 'default_branch': 'main'},
    'workflow_run': {
        'id': 123, 'head_sha': 'validated-pr-head', 'event': 'pull_request',
        'conclusion': 'success', 'pull_requests': [{'number': 7}],
    },
}


class ReadFailure(io.BytesIO):
    def __init__(self, error):
        super().__init__()
        self.error = error

    def read(self, *args):
        raise self.error


class QuayReviewTests(unittest.TestCase):
    def submit(self, event_name='workflow_run', event=None, github_result=None,
               outcomes=(), environment=None, github_outcomes=()):
        self.requests = []
        self.attempts = []
        self.output = io.StringIO()
        outcomes = iter(outcomes)
        github_outcomes = iter(github_outcomes)

        def urlopen(request, timeout):
            self.requests.append(request)
            self.attempts.append((request.full_url, request.get_method(), request.data, dict(request.header_items())))
            if request.full_url.startswith('https://api.github.com/'):
                self.assertEqual(request.get_header('Authorization'), 'Bearer dummy-github-token')
                result = next(github_outcomes, github_result)
            else:
                self.assertEqual(request.full_url, 'https://quay.example/quay/v2/review-pr')
                self.assertEqual(request.get_header('Authorization'), 'Bearer dummy-quay-token')
                result = next(outcomes, {'status': 'accepted'})
            if isinstance(result, Exception):
                raise result
            if isinstance(result, ReadFailure):
                return result
            return io.BytesIO(result if isinstance(result, bytes) else json.dumps(result).encode())

        def make_opener(handler):
            self.redirect_handler = handler
            return SimpleNamespace(open=urlopen)

        with tempfile.TemporaryDirectory() as folder:
            event_path = Path(folder) / 'event.json'
            event_path.write_text(json.dumps(RUN if event is None else event))
            env = {
                'GITHUB_EVENT_PATH': str(event_path), 'GITHUB_EVENT_NAME': event_name,
                'GITHUB_REF': 'refs/heads/main',
                'GITHUB_RUN_ID': '456', 'GITHUB_SHA': 'notifier-default-branch-sha',
                'GH_TOKEN': 'dummy-github-token',
                'QUAY_REVIEW_URL': 'https://quay.example',
                'QUAY_REVIEW_PR_TOKEN': 'dummy-quay-token',
            }
            env.update(environment or {})
            with patch.dict(os.environ, env, clear=True), \
                 patch('urllib.request.build_opener', side_effect=make_opener), \
                 patch('time.sleep') as sleep, contextlib.redirect_stdout(self.output):
                self.sleep = sleep
                exec(compile(SCRIPT, '.github/workflows/quay-review.yml', 'exec'), {})
        return [json.loads(request.data) for request in self.requests if request.data]

    def test_automatic_payload_preserves_source_run_identity(self):
        self.assertEqual(self.submit(), [{
            'kind': 'ci', 'repository': REPOSITORY, 'pull_request': 7,
            'workflow_run_id': 123, 'head_sha': 'validated-pr-head',
        }])

    def test_draft_and_stacked_prs_use_the_same_request_path(self):
        event = copy.deepcopy(RUN)
        event['workflow_run']['pull_requests'] = [
            {'number': 7, 'draft': True, 'base': {'ref': 'feature/parent'}},
            {'number': 8, 'draft': False, 'base': {'ref': 'main'}},
        ]
        self.assertEqual([payload['pull_request'] for payload in self.submit(event=event)], [7, 8])

    def test_empty_run_associations_use_commit_lookup(self):
        event = copy.deepcopy(RUN)
        event['workflow_run']['pull_requests'] = []
        payloads = self.submit(event=event, github_result=[{'number': 9}])
        self.assertEqual(self.requests[0].full_url,
                         f'https://api.github.com/repos/{REPOSITORY}/commits/validated-pr-head/pulls?per_page=100')
        self.assertEqual(payloads[0]['pull_request'], 9)
        self.assertEqual(payloads[0]['head_sha'], 'validated-pr-head')

    def test_no_association_reports_missing_pr_without_submitting(self):
        event = copy.deepcopy(RUN)
        event['workflow_run']['pull_requests'] = []
        with self.assertRaisesRegex(SystemExit, 'No PR associated'):
            self.submit(event=event, github_result=[])
        self.assertTrue(all(request.data is None for request in self.requests))

    def test_manual_modes_preserve_dispatch_identity(self):
        for mode in ('targeted', 'full'):
            with self.subTest(mode=mode):
                event = {'repository': RUN['repository'], 'inputs': {'pull_request': '7', 'mode': mode}}
                self.assertEqual(self.submit('workflow_dispatch', event), [{
                    'kind': 'manual', 'repository': REPOSITORY, 'pull_request': 7,
                    'workflow_run_id': 456, 'mode': mode,
                }])

    def test_invalid_manual_pr_numbers_fail_without_submission(self):
        for number in ('0', '-1', '7; echo invalid', '1.5'):
            with self.subTest(number=number), self.assertRaisesRegex(SystemExit, 'positive integer'):
                self.submit('workflow_dispatch', {
                    'repository': RUN['repository'], 'inputs': {'pull_request': number, 'mode': 'full'},
                })
            self.assertEqual(self.requests, [])

    def test_review_commands_forward_comment_identity(self):
        for body in ('/review', '/review verify', '/review full', '/Review FULL', '  /review full \n', '\t/review\tverify', '/review\nfull'):
            with self.subTest(body=body):
                event = {'repository': RUN['repository'], 'issue': {'number': 7},
                         'comment': {'id': 89, 'body': body}}
                self.assertEqual(self.submit('issue_comment', event), [{
                    'kind': 'comment', 'repository': REPOSITORY, 'pull_request': 7, 'comment_id': 89,
                }])

    def test_unrelated_comments_do_not_submit(self):
        for body in ('looks good', '/reviewer', '/review full extra', '/review nope', 'please /review', '/review; echo hi', ''):
            with self.subTest(body=body), self.assertRaises(SystemExit) as result:
                self.submit('issue_comment', {'repository': RUN['repository'], 'comment': {'body': body}})
            self.assertEqual(result.exception.code, 0)
            self.assertEqual(self.requests, [])

    def test_closure_forwards_cancellation_identity(self):
        self.assertEqual(self.submit('pull_request_target', {
            'repository': RUN['repository'], 'pull_request': {'number': 7},
        }), [{'kind': 'closed', 'repository': REPOSITORY, 'pull_request': 7}])

    def test_missing_or_insecure_configuration_fails_before_network(self):
        for env in ({'QUAY_REVIEW_PR_TOKEN': ''}, {'QUAY_REVIEW_URL': ''},
                    {'QUAY_REVIEW_URL': 'http://quay.example'},
                    {'QUAY_REVIEW_URL': 'https://user:password@quay.example'},
                    {'QUAY_REVIEW_URL': 'https://:password@quay.example'},
                    {'QUAY_REVIEW_URL': 'https://@quay.example'},
                    {'QUAY_REVIEW_URL': 'https://[private'},
                    {'QUAY_REVIEW_URL': 'https://quay.example:private'}):
            with self.subTest(env=env), self.assertRaisesRegex(SystemExit, 'Configure the HTTPS') as result:
                self.submit(environment=env)
            self.assertEqual(self.requests, [])
            self.assertNotIn('dummy-quay-token', str(result.exception) + self.output.getvalue())
            self.assertNotIn('password', str(result.exception) + self.output.getvalue())

    def test_transient_errors_retry_the_same_payload(self):
        errors = [urllib.error.HTTPError('https://quay.example', 503, 'private details', {}, None),
                  urllib.error.URLError('private network details'), TimeoutError()]
        payloads = self.submit(outcomes=errors)
        self.assertEqual(len(payloads), 4)
        self.assertTrue(all(payload == payloads[0] for payload in payloads))
        self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [1, 2, 4])
        self.assertNotIn('private', self.output.getvalue())

    def test_retry_exhaustion_fails_with_sanitized_status(self):
        error = urllib.error.HTTPError('https://quay.example', 503, 'private details', {}, None)
        with self.assertRaisesRegex(SystemExit, r'HTTP 503') as result:
            self.submit(outcomes=[error] * 4)
        self.assertEqual(len(self.requests), 4)
        self.assertNotIn('private', str(result.exception) + self.output.getvalue())

    def test_permanent_failure_is_not_retried(self):
        error = urllib.error.HTTPError('https://quay.example', 401, 'private details', {}, None)
        with self.assertRaisesRegex(SystemExit, r'HTTP 401'):
            self.submit(outcomes=[error])
        self.assertEqual(len(self.requests), 1)
        self.sleep.assert_not_called()

    def test_ineligible_response_does_not_retry(self):
        error = urllib.error.HTTPError('https://quay.example', 422, 'private details', {}, None)
        self.assertEqual(len(self.submit(outcomes=[error])), 1)
        self.assertIn('no longer eligible', self.output.getvalue())
        self.sleep.assert_not_called()

    def test_manual_dispatch_requires_default_branch_without_network(self):
        event = {'repository': RUN['repository'], 'inputs': {'pull_request': '7', 'mode': 'full'}}
        for ref in ('refs/heads/feature', 'refs/tags/main'):
            with self.subTest(ref=ref), self.assertRaisesRegex(SystemExit, 'default branch'):
                self.submit('workflow_dispatch', event, environment={'GITHUB_REF': ref})
            self.assertEqual(self.requests, [])
        event['repository'] = dict(RUN['repository'], default_branch='staging')
        self.assertEqual(self.submit('workflow_dispatch', event,
                         environment={'GITHUB_REF': 'refs/heads/staging'})[0]['pull_request'], 7)

    def test_invalid_manual_mode_does_not_submit(self):
        with self.assertRaisesRegex(SystemExit, 'mode must be'):
            self.submit('workflow_dispatch', {'repository': RUN['repository'],
                        'inputs': {'pull_request': '7', 'mode': 'unknown'}})
        self.assertEqual(self.requests, [])

    def test_unrelated_comment_needs_no_credentials(self):
        with self.assertRaises(SystemExit) as result:
            self.submit('issue_comment', {'repository': RUN['repository'],
                        'comment': {'body': 'looks good'}},
                        environment={'QUAY_REVIEW_URL': '', 'QUAY_REVIEW_PR_TOKEN': ''})
        self.assertEqual(result.exception.code, 0)
        self.assertEqual(self.requests, [])

    def test_github_lookup_retries_transient_failures(self):
        event = copy.deepcopy(RUN)
        event['workflow_run']['pull_requests'] = []
        errors = [urllib.error.HTTPError('https://api.github.com', 503, 'private', {}, None),
                  urllib.error.URLError('private'), TimeoutError()]
        payloads = self.submit(event=event, github_result=[{'number': 9}], github_outcomes=errors)
        self.assertEqual(payloads[0]['pull_request'], 9)
        self.assertEqual(len(self.requests), 5)
        self.assertTrue(all(request.full_url == self.requests[0].full_url for request in self.requests[:4]))
        self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [1, 2, 4])

    def test_github_lookup_failure_is_sanitized_and_never_submits(self):
        event = copy.deepcopy(RUN)
        event['workflow_run']['pull_requests'] = []
        for code, attempts in ((403, 1), (404, 1), (503, 4)):
            with self.subTest(code=code), self.assertRaisesRegex(SystemExit, f'HTTP {code}') as result:
                self.submit(event=event, github_outcomes=[
                    urllib.error.HTTPError('https://api.github.com/private', code, 'private', {}, None)
                ] * attempts)
            self.assertEqual(len(self.requests), attempts)
            self.assertTrue(all(request.data is None for request in self.requests))
            self.assertNotIn('private', str(result.exception) + self.output.getvalue())

    def test_github_lookup_invalid_json_never_submits(self):
        event = copy.deepcopy(RUN)
        event['workflow_run']['pull_requests'] = []
        with self.assertRaisesRegex(SystemExit, 'GitHub PR association lookup returned an invalid JSON response') as error:
            self.submit(event=event, github_outcomes=[b'private invalid JSON'])
        self.assertEqual(len(self.requests), 1)
        self.assertIsNone(self.requests[0].data)
        self.assertNotIn('private', str(error.exception) + self.output.getvalue())

    def test_network_retry_exhaustion_is_sanitized(self):
        for error in (urllib.error.URLError('private'), TimeoutError('private')):
            with self.subTest(error=type(error)), self.assertRaisesRegex(SystemExit, 'could not be reached') as result:
                self.submit(outcomes=[error] * 4)
            self.assertEqual(len(self.requests), 4)
            self.assertNotIn('private', str(result.exception) + self.output.getvalue())

    def connection_failure_cases(self):
        for service in ('GitHub', 'Quay'):
            for stage in ('open', 'read'):
                for error_type in (http.client.RemoteDisconnected, ConnectionResetError, http.client.IncompleteRead):
                    event = copy.deepcopy(RUN)
                    if service == 'GitHub':
                        event['workflow_run']['pull_requests'] = []
                    errors = [error_type(b'private response details') for _ in range(4)]
                    failures = [ReadFailure(error) for error in errors] if stage == 'read' else errors
                    yield service, stage, event, failures

    def test_connection_failures_retry_open_and_read_with_stable_requests(self):
        for service, stage, event, failures in self.connection_failure_cases():
            error = failures[0].error if stage == 'read' else failures[0]
            with self.subTest(service=service, stage=stage, error=type(error).__name__):
                options = {'github_outcomes' if service == 'GitHub' else 'outcomes': failures[:3]}
                payloads = self.submit(event=event, github_result=[{'number': 7}], **options)
                self.assertEqual(payloads[-1], {
                    'kind': 'ci', 'repository': REPOSITORY, 'pull_request': 7,
                    'workflow_run_id': 123, 'head_sha': 'validated-pr-head',
                })
                self.assertEqual(len(self.requests), 5 if service == 'GitHub' else 4)
                self.assertEqual(self.attempts[:4], [self.attempts[0]] * 4)
                self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [1, 2, 4])
                self.assertNotIn('private', self.output.getvalue())
                if stage == 'read':
                    self.assertTrue(all(response.closed for response in failures[:3]))

    def test_connection_failure_exhaustion_is_bounded_and_sanitized(self):
        for service, stage, event, failures in self.connection_failure_cases():
            error = failures[0].error if stage == 'read' else failures[0]
            with self.subTest(service=service, stage=stage, error=type(error).__name__):
                options = {'github_outcomes' if service == 'GitHub' else 'outcomes': failures}
                with self.assertRaisesRegex(SystemExit, 'could not be reached; rerun this workflow') as result:
                    self.submit(event=event, **options)
                self.assertEqual(len(self.requests), 4)
                self.assertEqual(self.attempts, [self.attempts[0]] * 4)
                self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [1, 2, 4])
                self.assertNotIn('private', str(result.exception) + self.output.getvalue())
                if service == 'GitHub':
                    self.assertTrue(all(request.data is None for request in self.requests))
                if stage == 'read':
                    self.assertTrue(all(response.closed for response in failures))

    def test_retryable_http_statuses(self):
        for code in (429, 500, 502, 503, 504):
            with self.subTest(code=code):
                self.assertEqual(len(self.submit(outcomes=[
                    urllib.error.HTTPError('https://quay.example', code, 'private', {}, None)
                ])), 2)

    def test_explicit_requests_do_not_silently_swallow_422(self):
        events = {
            'workflow_dispatch': {'repository': RUN['repository'], 'inputs': {'pull_request': '7', 'mode': 'full'}},
            'issue_comment': {'repository': RUN['repository'], 'issue': {'number': 7},
                              'comment': {'id': 89, 'body': '/review'}},
        }
        for name, event in events.items():
            with self.subTest(name=name), self.assertRaisesRegex(SystemExit, 'HTTP 422'):
                self.submit(name, event, outcomes=[
                    urllib.error.HTTPError('https://quay.example', 422, 'private', {}, None)])
            self.assertEqual(len(self.requests), 1)
            self.sleep.assert_not_called()

    def test_closure_ineligibility_is_benign(self):
        self.submit('pull_request_target', {'repository': RUN['repository'], 'pull_request': {'number': 7}},
                    outcomes=[urllib.error.HTTPError('https://quay.example', 422, 'private', {}, None)])
        self.assertIn('no longer eligible', self.output.getvalue())

    def test_authenticated_requests_never_follow_redirects(self):
        # Exercise the actual handler, not the mocked HTTP response path alone.
        self.submit()
        request = self.requests[0]
        for code in (301, 302, 303, 307, 308):
            for target in ('https://other.example', 'http://quay.example', 'https://quay.example/other'):
                with self.subTest(code=code, target=target):
                    self.assertIsNone(self.redirect_handler.redirect_request(
                        request, None, code, 'redirect', {}, target))
            with self.subTest(code=code), self.assertRaisesRegex(SystemExit, f'HTTP {code}'):
                self.submit(outcomes=[urllib.error.HTTPError('https://quay.example', code, 'private', {}, None)])
            self.assertEqual(len(self.requests), 1)
            self.sleep.assert_not_called()

    def test_response_shape_errors_are_sanitized(self):
        for result in (None, 'private', 1, [], b'private invalid JSON', b'\xff'):
            with self.subTest(result=result), self.assertRaisesRegex(SystemExit, 'invalid') as error:
                self.submit(outcomes=[result])
            self.assertNotIn('private', str(error.exception) + self.output.getvalue())

    def test_unsupported_event_never_submits(self):
        with self.assertRaisesRegex(SystemExit, 'Unsupported review event'):
            self.submit('push', {'repository': RUN['repository']})
        self.assertEqual(self.requests, [])

    def test_outer_job_gate(self):
        # This gate uses only operators/property access shared by Actions and JS.
        # Evaluate the actual YAML expression, rather than a Python copy of it.
        gate = re.search(r'    if: >-\n(.*?)\n    env:', WORKFLOW, re.S).group(1).strip()
        cases = []
        def add(name, event, expected):
            cases.append({'github': {'event_name': name, 'event': event}, 'expected': expected})
        for conclusion in ('success', 'failure', 'cancelled', 'skipped', 'timed_out'):
            for source in ('pull_request', 'push', 'workflow_dispatch', 'pull_request_target'):
                add('workflow_run', {'workflow_run': {'conclusion': conclusion, 'event': source}},
                    conclusion == 'success' and source == 'pull_request')
        for body in ('/review', '  /Review FULL', '\n/review verify', 'ordinary comment', '/reviewer'):
            add('issue_comment', {'issue': {'pull_request': {'url': 'fixture'}}, 'comment': {'body': body}}, True)
            add('issue_comment', {'issue': {}, 'comment': {'body': body}}, False)
        add('workflow_dispatch', {}, True)
        add('pull_request_target', {}, True)
        add('push', {}, False)
        js = "const fs=require('node:fs');const {gate,cases}=JSON.parse(fs.readFileSync(0,'utf8'));" \
             "const evaluate=new Function('github','return Boolean('+gate+')');" \
             "for(const c of cases){if(evaluate(c.github)!==c.expected)throw Error(JSON.stringify(c));}"
        subprocess.run(['node', '-e', js], input=json.dumps({'gate': gate, 'cases': cases}),
                       text=True, check=True, capture_output=True)

    def test_workflow_gate_and_credential_boundary(self):
        trigger = WORKFLOW.split('permissions:', 1)[0]
        self.assertIn('types: [completed]', trigger)
        self.assertIn('types: [created]', trigger)
        self.assertIn('types: [closed]', trigger)
        self.assertNotIn('branches:', trigger)
        self.assertIn("(github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'pull_request')", WORKFLOW)
        self.assertNotIn('concurrency:', WORKFLOW)
        self.assertNotIn('uses:', WORKFLOW)
        self.assertNotIn('git ', SCRIPT)
        self.assertIn('permissions:\n  contents: read\n  pull-requests: read', WORKFLOW)
        self.assertNotIn(': write', WORKFLOW)
        self.assertNotIn('id-token:', WORKFLOW)

    def test_repository_ci_wiring(self):
        self.assertIn('workflows: [ci]', WORKFLOW.split('permissions:', 1)[0])
        ci = (ROOT / '.github/workflows/ci.yml').read_text()
        self.assertIn('  pull_request:', ci)
        self.assertIn('quay-review-tests:', ci)
        self.assertIn('persist-credentials: false', ci)
        self.assertIn('python3 -m unittest discover -s test-quay -v', ci)
        job = ci.split('  quay-review-tests:', 1)[1].split('\n  ', 1)[0]
        self.assertNotIn('if:', job)


if __name__ == '__main__':
    unittest.main()
