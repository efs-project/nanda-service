export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function unauthorized(message = "Invalid or missing API key"): HttpError {
  return new HttpError(401, "unauthorized", message);
}

export function forbidden(message: string): HttpError {
  return new HttpError(403, "forbidden", message);
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, "bad_request", message);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, "conflict", message);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, "not_found", message);
}

export function rateLimited(message: string): HttpError {
  return new HttpError(429, "rate_limited", message);
}
