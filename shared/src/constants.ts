/** Protocol and policy constants shared by the web client, the API and the sweeper (PLAN sections 6, 7, 12). */

export const PROTOCOL_VERSION = 'v1';
export const AAD_PREFIX = 'brix-share/v1';
export const HKDF_INFO_PASSPHRASE = 'brix-share/v1/passphrase';
export const PBKDF2_ITERATIONS = 600_000;

export const ID_BYTES = 16;
export const KEY_BYTES = 32;
export const MANAGE_TOKEN_BYTES = 32;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;
/** Bytes added to a file by its envelope: IV prefix plus GCM tag. */
export const FILE_OVERHEAD_BYTES = IV_BYTES + GCM_TAG_BYTES;

export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_TITLE_CHARS = 200;
export const MAX_CT_CHARS = 96 * 1024;
export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_FILES = 10;
export const MAX_TOTAL_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_VIEWS = 100;
export const MAX_RETRIEVALS_LOGGED = 100;

export const MINUTE = 60;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Expiry must be strictly later than now + this. */
export const MIN_LIFETIME_SEC = 5 * MINUTE;
/** Expiry may be at most now + this. */
export const MAX_LIFETIME_SEC = 30 * DAY;
export const DEFAULT_LIFETIME_SEC = 7 * DAY;
/** availableFrom must be strictly earlier than expiresAt minus this. */
export const AVAILABILITY_GAP_SEC = 5 * MINUTE;
export const TOMBSTONE_RETENTION_SEC = 30 * DAY;
export const CHALLENGE_TTL_SEC = 10 * MINUTE;
export const PENDING_MAX_AGE_SEC = HOUR;
/** Objects of an ended secret stay this long after the end, for downloads started just before it. */
export const DOWNLOAD_GRACE_SEC = 5 * MINUTE;
export const UPLOAD_URL_TTL_SEC = 15 * MINUTE;
export const DOWNLOAD_URL_TTL_SEC = 2 * MINUTE;
export const DEFAULT_POW_DIFFICULTY = 18;
export const MIN_POW_DIFFICULTY = 8;
export const MAX_POW_DIFFICULTY = 24;

/** Header carrying the manage token. Not `Authorization`: CloudFront OAC overwrites that header with its SigV4 signature. */
export const MANAGE_TOKEN_HEADER = 'x-manage-token';

/**
 * Largest plaintext (UTF-8 JSON payload) whose ciphertext+tag still fits MAX_CT_CHARS once base64url encoded.
 * The client checks this before encrypting; text over MAX_TEXT_BYTES is rejected earlier in the UI.
 */
export const MAX_PAYLOAD_BYTES = Math.floor((MAX_CT_CHARS * 3) / 4) - GCM_TAG_BYTES;
