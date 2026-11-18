// Cleanup handlers registered with ctx.onClose(fn). Used for the normal shutdown and for the
// rollback of a failed start-up.
//
// Contract:
//  - handlers run one at a time, last registered first;
//  - a handler that throws is logged and does not stop the others;
//  - a handler that never finishes cannot hold the shutdown longer than `timeoutMs`; the
//    handlers behind it are still started, but not waited for;
//  - handlers registered while closing (by code that is still starting up) are closed too;
//  - handlers registered after closing has finished run immediately.
export class ResourceStack {
  #items = [];
  #counter = 0;
  #running = null;
  #closed = false;
  #late = new Set();
  #active = null;
  #log;

  constructor({ log }) {
    this.#log = log;
  }

  get closed() {
    return this.#closed;
  }

  // name of the handler that is running right now (what a forced shutdown is waiting for)
  get active() {
    return this.#active;
  }

  get size() {
    return this.#items.length;
  }

  add(fn, { name } = {}) {
    if (typeof fn !== 'function') throw new TypeError('ctx.onClose: the handler must be a function');
    const item = { fn, name: name ?? (fn.name || `resource #${++this.#counter}`) };
    if (this.#closed) {
      this.#log.warn({ resource: item.name }, 'ctx.onClose called after shutdown finished: running the handler now');
      const run = this.#run(item).then(({ error }) => error && this.#log.error({ err: error, resource: item.name }, 'Error while closing a resource'));
      this.#late.add(run);
      run.finally(() => this.#late.delete(run));
    } else {
      this.#items.push(item);
    }
  }

  // Resolves to { errors: [{ name, error }], pending: [name], abandoned: [name], timedOut }
  closeAll({ timeoutMs = Infinity } = {}) {
    this.#running ??= this.#drain(timeoutMs);
    return this.#running;
  }

  async settled() {
    await Promise.all([...this.#late]);
  }

  async #run(item) {
    try {
      await item.fn();
      return {};
    } catch (error) {
      return { error };
    }
  }

  async #drain(timeoutMs) {
    const result = { errors: [], pending: [], abandoned: [], timedOut: false };
    const deadline = Date.now() + timeoutMs;

    while (this.#items.length) {
      const item = this.#items.pop();

      if (result.timedOut) {
        // no time left: give the handler its chance anyway, but do not wait for it
        result.abandoned.push(item.name);
        this.#run(item).then(({ error }) => error && this.#log.error({ err: error, resource: item.name }, 'Error while closing a resource'));
        continue;
      }

      this.#active = item.name;
      let timer;
      const outcome = await Promise.race([
        this.#run(item),
        new Promise((resolve) => {
          // not unref'd: while a handler hangs, this timer is what keeps the process alive until the deadline
          timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), 'timeout');
        }),
      ]);
      clearTimeout(timer);
      if (outcome !== 'timeout') this.#active = null;

      if (outcome === 'timeout') {
        result.timedOut = true;
        result.pending.push(item.name);
        this.#log.error({ resource: item.name }, `Closing "${item.name}" did not finish in time`);
      } else if (outcome.error) {
        result.errors.push({ name: item.name, error: outcome.error });
        this.#log.error({ err: outcome.error, resource: item.name }, 'Error while closing a resource');
      }
    }

    this.#closed = true;
    return result;
  }
}
