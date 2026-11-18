// Errors raised by the framework itself (as opposed to HttpError, which describes a response).
// Every WhiteError has a stable `code` for programmatic handling and an optional `hint` that
// tells the developer what to do next. The CLI prints them without a stack trace.

export class WhiteError extends Error {
  constructor(message, { code = 'WHITE_ERROR', hint, details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    if (hint) this.hint = hint;
    if (details !== undefined) this.details = details;
  }
}

// Thrown for problems the user must fix in white.config.js or the environment
export class ConfigError extends WhiteError {
  constructor(message, options) {
    super(message, { code: 'CONFIG_INVALID', ...options });
  }
}

// start()/stop() called in a state where they cannot work
export class LifecycleError extends WhiteError {
  constructor(message, options) {
    super(message, { code: 'LIFECYCLE_INVALID_STATE', ...options });
  }
}

export class PortInUseError extends WhiteError {
  constructor(port, options) {
    super(`Port ${port} is already in use`, {
      code: 'PORT_IN_USE',
      hint: 'Stop the other process, or set PORT (or "port" in white.config.js) to a free port.',
      ...options,
    });
    this.port = port;
  }
}

export class ListenError extends WhiteError {
  constructor(port, cause) {
    super(`The server could not listen on port ${port}: ${cause.message}`, { code: cause.code ?? 'LISTEN_FAILED', cause });
    this.port = port;
  }
}

// Route directory problems: unknown group, bad parameter name, two files for one URL
export class RouteLoadError extends WhiteError {
  constructor(message, options) {
    super(message, { code: 'ROUTE_INVALID', ...options });
  }
}

export class PluginResolutionError extends WhiteError {
  constructor(message, options) {
    super(message, { code: 'PLUGIN_RESOLUTION_FAILED', ...options });
  }
}

// A protocol is blocked, removed, missing an implementation or incompatible
export class ProtocolError extends WhiteError {
  constructor(message, options) {
    super(message, { code: 'PROTOCOL_INCOMPATIBLE', ...options });
  }
}

export class MigrationError extends WhiteError {
  constructor(message, options) {
    super(message, { code: 'MIGRATION_FAILED', ...options });
  }
}
