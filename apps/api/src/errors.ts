export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST') =>
  new HttpError(400, code, message);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have access to this resource') =>
  new HttpError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string, code = 'CONFLICT') => new HttpError(409, code, message);
