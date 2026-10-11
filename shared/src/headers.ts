/**
 * Security headers (PLAN section 11). CloudFront sets them on every response through a response headers
 * policy; the API mirrors them so a direct response carries the same policy.
 */

export const PERMISSIONS_POLICY =
  'accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), xr-spatial-tracking=()';

export const HSTS_MAX_AGE_SEC = 63_072_000;

/**
 * Name of a stage's files bucket. Deterministic so the CSP, IAM and the monitor can name it up front. The suffix
 * is random per stage (stage config), so the public bucket name does not reveal the account id.
 */
export function filesBucketName(stage: string, suffix: string): string {
  return `brix-share-${stage}-files-${suffix}`;
}

/** Origin of the files bucket as browsers see it for presigned URLs (virtual-hosted style). */
export function filesBucketOrigin(bucketName: string, region: string): string {
  return `https://${bucketName}.s3.${region}.amazonaws.com`;
}

export function contentSecurityPolicy(filesOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${filesOrigin}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export function securityHeaders(filesOrigin: string): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy(filesOrigin),
    'strict-transport-security': `max-age=${HSTS_MAX_AGE_SEC}; includeSubDomains; preload`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-robots-tag': 'noindex, nofollow',
    'permissions-policy': PERMISSIONS_POLICY,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };
}
