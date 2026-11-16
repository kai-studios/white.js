// Throw these from any route handler; the error handler turns them into responses.
export class HttpError extends Error {
  constructor(status = 500, message = 'Error', details) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export class BadRequestError extends HttpError {
  constructor(message = 'Bad request', details) {
    super(400, message, details);
  }
}
export class UnauthorizedError extends HttpError {
  constructor(message = 'Unauthorized') {
    super(401, message);
  }
}
export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden') {
    super(403, message);
  }
}
export class NotFoundError extends HttpError {
  constructor(message = 'Not found') {
    super(404, message);
  }
}
export class ConflictError extends HttpError {
  constructor(message = 'Conflict') {
    super(409, message);
  }
}
export class ValidationError extends HttpError {
  constructor(details, message = 'Validation failed') {
    super(422, message, details);
  }
}
