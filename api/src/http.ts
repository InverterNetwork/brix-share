import { ERROR_STATUS, securityHeaders, type ErrorCode } from '@brix-share/shared';

export interface FunctionUrlEvent {
  rawPath: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

let cachedHeaders: Record<string, string> | undefined;
let cachedFor: string | undefined;

function baseHeaders(filesOrigin: string): Record<string, string> {
  if (cachedFor !== filesOrigin) {
    cachedHeaders = {
      ...securityHeaders(filesOrigin),
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    };
    cachedFor = filesOrigin;
  }
  return cachedHeaders!;
}

export class Responder {
  private readonly filesOrigin: string;

  constructor(filesOrigin: string) {
    this.filesOrigin = filesOrigin;
  }

  json(statusCode: number, body: unknown): FunctionUrlResult {
    return {
      statusCode,
      headers: baseHeaders(this.filesOrigin),
      body: body === undefined ? '' : JSON.stringify(body),
    };
  }

  empty(statusCode: number): FunctionUrlResult {
    return { statusCode, headers: baseHeaders(this.filesOrigin), body: '' };
  }

  error(code: ErrorCode, message: string, extra: Record<string, unknown> = {}): FunctionUrlResult {
    return this.json(ERROR_STATUS[code], { error: code, message, ...extra });
  }
}

/** Header lookup; Function URL events deliver lower-cased header names. */
export function header(event: FunctionUrlEvent, name: string): string | undefined {
  return event.headers?.[name.toLowerCase()];
}
