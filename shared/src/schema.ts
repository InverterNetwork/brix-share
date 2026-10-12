import { z } from 'zod';
import { ERROR_STATUS, type ErrorCode } from './errors.ts';
import { B64URL_RE, b64urlDecode, isB64urlOfLength } from './b64url.ts';
import {
  GCM_TAG_BYTES,
  ID_BYTES,
  IV_BYTES,
  KEY_BYTES,
  MAX_CT_CHARS,
  MAX_FILES,
  MAX_TOTAL_FILE_BYTES,
  MAX_VIEWS,
  PROTOCOL_VERSION,
  SALT_BYTES,
} from './constants.ts';

// No `new Function` JIT: the web app runs under `script-src 'self'` without 'unsafe-eval', and zod's eval
// probe alone already triggers a CSP violation report.
z.config({ jitless: true });

const b64urlBytes = (bytes: number) =>
  z.string().refine((s) => isB64urlOfLength(s, bytes), `expected ${bytes} bytes base64url`);

/** 16 random bytes, base64url, 22 chars. Used for secret ids and file ids. */
export const IdSchema = b64urlBytes(ID_BYTES);

const CiphertextSchema = z
  .string()
  .max(MAX_CT_CHARS)
  .regex(B64URL_RE)
  .refine((s) => {
    try {
      return b64urlDecode(s).length >= GCM_TAG_BYTES;
    } catch {
      return false;
    }
  }, 'invalid ciphertext');

const IsoDateSchema = z.iso.datetime();

export const EnvelopeSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  id: IdSchema,
  iv: b64urlBytes(IV_BYTES),
  salt: b64urlBytes(SALT_BYTES).nullable(),
  ct: CiphertextSchema,
  hasPassphrase: z.boolean(),
  fileIds: z.array(IdSchema).max(MAX_FILES),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const PolicyInputSchema = z.strictObject({
  maxViews: z.int().min(1).max(MAX_VIEWS).nullable(),
  expiresAt: IsoDateSchema,
  availableFrom: IsoDateSchema.nullable(),
});
export type PolicyInput = z.infer<typeof PolicyInputSchema>;

export const FileDeclSchema = z.strictObject({
  fileId: IdSchema,
  size: z.int().min(0).max(MAX_TOTAL_FILE_BYTES),
});

export const PowSolutionSchema = z.strictObject({
  challenge: z.string().min(1).max(256),
  nonce: z.string().regex(/^[0-9]{1,16}$/),
});

export const CreateRequestSchema = z.strictObject({
  envelope: EnvelopeSchema,
  policy: PolicyInputSchema,
  manageTokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  consumeTokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  pow: PowSolutionSchema,
  files: z.array(FileDeclSchema).max(MAX_FILES),
});
export type CreateRequest = z.infer<typeof CreateRequestSchema>;

/** Plaintext inside the text envelope. Validated by the client after decryption. */
export const PayloadSchema = z.strictObject({
  title: z.string().nullable(),
  text: z.string(),
  files: z
    .array(
      z.strictObject({
        fileId: IdSchema,
        name: z.string().max(1024),
        size: z.int().min(0).max(MAX_TOTAL_FILE_BYTES),
        mime: z.string().max(255),
        key: b64urlBytes(KEY_BYTES),
      }),
    )
    .max(MAX_FILES),
});
export type Payload = z.infer<typeof PayloadSchema>;

export const ChallengeResponseSchema = z.strictObject({
  challenge: z.string(),
  difficulty: z.int().min(0).max(32),
  expiresAt: IsoDateSchema,
});
export type ChallengeResponse = z.infer<typeof ChallengeResponseSchema>;

export const CreateResponseSchema = z.strictObject({
  id: IdSchema,
  expiresAt: IsoDateSchema,
  availableFrom: IsoDateSchema.nullable(),
  maxViews: z.int().nullable(),
  uploads: z.array(
    z.strictObject({
      fileId: IdSchema,
      url: z.string(),
      headers: z.record(z.string(), z.string()),
    }),
  ),
});
export type CreateResponse = z.infer<typeof CreateResponseSchema>;

export const ConsumeResponseSchema = z.strictObject({
  envelope: EnvelopeSchema,
  policy: z.strictObject({
    viewsRemaining: z.int().nullable(),
    expiresAt: IsoDateSchema,
  }),
  downloads: z.array(z.strictObject({ fileId: IdSchema, url: z.string() })),
});
export type ConsumeResponse = z.infer<typeof ConsumeResponseSchema>;

export const TooEarlyResponseSchema = z.strictObject({
  error: z.literal('too_early'),
  message: z.string(),
  availableFrom: IsoDateSchema,
});
export type TooEarlyResponse = z.infer<typeof TooEarlyResponseSchema>;

/** `GET /api/secrets/{id}`: whether the share link can be opened, without counting a retrieval. */
export const AvailabilityResponseSchema = z.strictObject({
  availableFrom: IsoDateSchema.nullable(),
});
export type AvailabilityResponse = z.infer<typeof AvailabilityResponseSchema>;

export const SecretStatus = z.enum(['pending', 'ready', 'ended']);
export const EndedReason = z.enum(['consumed', 'expired', 'deleted']);

export const StatusResponseSchema = z.strictObject({
  exists: z.boolean(),
  status: SecretStatus,
  hasPassphrase: z.boolean(),
  viewsRemaining: z.int().nullable(),
  maxViews: z.int().nullable(),
  expiresAt: IsoDateSchema,
  availableFrom: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
  fileCount: z.int().min(0),
  endedAt: IsoDateSchema.nullable(),
  endedReason: EndedReason.nullable(),
  /** When the tombstone (metadata-only history) is removed. Null while live. */
  historyUntil: IsoDateSchema.nullable(),
  /** All successful retrievals; `retrievals` lists at most the first 100. */
  retrievalCount: z.int().min(0),
  retrievals: z.array(z.strictObject({ at: IsoDateSchema, country: z.string() })),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

export const FinalizeResponseSchema = z.strictObject({ status: z.literal('ready') });
export type FinalizeResponse = z.infer<typeof FinalizeResponseSchema>;

export const ErrorResponseSchema = z.strictObject({
  error: z.enum(Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]]),
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** The decrypted payload must list exactly the files the envelope declares, in the same order. */
export function payloadMatchesEnvelope(payload: Payload, envelope: Envelope): boolean {
  return (
    payload.files.length === envelope.fileIds.length &&
    payload.files.every((f, i) => f.fileId === envelope.fileIds[i])
  );
}
