import { aws_wafv2 as wafv2 } from 'aws-cdk-lib';
import { MAX_BODY_BYTES } from '@brix-share/shared';

/**
 * Matches any decimal Content-Length above MAX_BODY_BYTES (131072). WAF on CloudFront only inspects the
 * first 16 to 64 KB of a body, so the header is the only way to enforce the 128 KB cap at the edge.
 */
export const CONTENT_LENGTH_OVER_CAP_REGEX =
  '^(?:[0-9]{7,}|[2-9][0-9]{5}|1[4-9][0-9]{4}|13[2-9][0-9]{3}|131[1-9][0-9]{2}|1310[8-9][0-9]|13107[3-9])$';

if (MAX_BODY_BYTES !== 131072)
  throw new Error('CONTENT_LENGTH_OVER_CAP_REGEX is written for a 131072-byte cap');

export const RATE_LIMITS = { create: 20, consume: 60, challenge: 60, global: 2000 } as const;

const visibility = (name: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
  cloudWatchMetricsEnabled: true,
  metricName: name,
  sampledRequestsEnabled: false,
});

// Paths are URL-decoded and lower-cased before matching so encoded or re-cased variants cannot slip past the
// per-route limits. The API router additionally 404s anything but the exact lower-case, unencoded path.
const uri = (
  searchString: string,
  positionalConstraint: string,
): wafv2.CfnWebACL.StatementProperty => ({
  byteMatchStatement: {
    fieldToMatch: { uriPath: {} },
    positionalConstraint,
    searchString,
    textTransformations: [
      { priority: 0, type: 'URL_DECODE' },
      { priority: 1, type: 'LOWERCASE' },
    ],
  },
});

const method = (m: string): wafv2.CfnWebACL.StatementProperty => ({
  byteMatchStatement: {
    fieldToMatch: { method: {} },
    positionalConstraint: 'EXACTLY',
    searchString: m,
    textTransformations: [{ priority: 0, type: 'NONE' }],
  },
});

const and = (
  ...statements: wafv2.CfnWebACL.StatementProperty[]
): wafv2.CfnWebACL.StatementProperty => ({
  andStatement: { statements },
});

const rateRule = (
  name: string,
  priority: number,
  limit: number,
  scopeDownStatement?: wafv2.CfnWebACL.StatementProperty,
): wafv2.CfnWebACL.RuleProperty => ({
  name,
  priority,
  action: { block: {} },
  statement: {
    rateBasedStatement: {
      limit,
      evaluationWindowSec: 300,
      aggregateKeyType: 'IP',
      ...(scopeDownStatement ? { scopeDownStatement } : {}),
    },
  },
  visibilityConfig: visibility(name),
});

export function webAclRules(): wafv2.CfnWebACL.RuleProperty[] {
  return [
    {
      name: 'BodyOverCap',
      priority: 0,
      action: { block: {} },
      statement: and(uri('/api/', 'STARTS_WITH'), {
        regexMatchStatement: {
          fieldToMatch: { singleHeader: { Name: 'content-length' } },
          regexString: CONTENT_LENGTH_OVER_CAP_REGEX,
          textTransformations: [{ priority: 0, type: 'NONE' }],
        },
      }),
      visibilityConfig: visibility('BodyOverCap'),
    },
    rateRule(
      'RateCreate',
      1,
      RATE_LIMITS.create,
      and(method('POST'), uri('/api/secrets', 'EXACTLY')),
    ),
    rateRule(
      'RateConsume',
      2,
      RATE_LIMITS.consume,
      and(method('POST'), uri('/api/secrets/', 'STARTS_WITH'), uri('/consume', 'CONTAINS')),
    ),
    rateRule('RateChallenge', 3, RATE_LIMITS.challenge, uri('/api/challenge', 'EXACTLY')),
    rateRule('RateGlobal', 4, RATE_LIMITS.global),
    {
      name: 'AWSCommon',
      priority: 5,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name: 'AWSManagedRulesCommonRuleSet',
          // Create bodies reach 128 KB; this rule blocks anything over 8 KB.
          ruleActionOverrides: [{ name: 'SizeRestrictions_BODY', actionToUse: { count: {} } }],
        },
      },
      visibilityConfig: visibility('AWSCommon'),
    },
  ];
}

export function webAclVisibility(): wafv2.CfnWebACL.VisibilityConfigProperty {
  return visibility('BrixShareAcl');
}
