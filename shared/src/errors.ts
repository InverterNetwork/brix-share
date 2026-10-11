/** API error codes and their HTTP status. Bodies are `{ error, message }` (ErrorResponseSchema). */
export const ERROR_STATUS = {
  invalid_request: 400,
  invalid_pow: 400,
  not_found: 404,
  id_conflict: 409,
  upload_incomplete: 409,
  payload_too_large: 413,
  too_early: 425,
  create_disabled: 503,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
