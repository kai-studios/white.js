import { AsyncLocalStorage } from 'node:async_hooks';

// Holds the id of the request being handled, so outgoing service calls made anywhere
// inside a route (even deep in async code) carry the same X-Request-Id automatically.
export const requestContext = new AsyncLocalStorage();
