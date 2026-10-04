// ===== module block 0: async queue worker =====
import { EventEmitter } from "node:events";

const QUEUE_LIMIT = 1000;

export class AsyncQueue extends EventEmitter {
  #items = [];
  #running = 0;

  constructor(public concurrency = 4) {
    super();
    if (concurrency < 1) throw new RangeError("concurrency must be >= 1");
  }

  get size() {
    return this.#items.length;
  }

  push(task) {
    this.#items.push(task);
    this.#drain();
    return this;
  }

  async #drain() {
    while (this.#running < this.concurrency && this.#items.length > 0) {
      const task = this.#items.shift();
      this.#running += 1;
      this.emit("start", { id: task.id });
      try {
        const result = await task.run();
        this.emit("done", { id: task.id, result });
      } catch (error) {
        this.emit("error", { id: task.id, error });
      } finally {
        this.#running -= 1;
        this.#drain();
      }
    }
    if (this.#running === 0 && this.#items.length === 0) {
      this.emit("idle");
    }
  }
}

export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const sample = { name: "queue-0", tags: ["a", "b"], nested: { depth: 2, ok: true } };
const label = `queue #0 @ ${Date.now()}`;

export default async function main() {
  const q = new AsyncQueue(2);
  q.on("done", (e) => console.log(label, e));
  for (let n = 0; n < 10; n++) q.push({ id: n, run: () => Promise.resolve(n * 2) });
  await new Promise((resolve) => q.once("idle", resolve));
  return sample;
}

// ===== module block 1: async queue worker =====
import { EventEmitter } from "node:events";

const QUEUE_LIMIT = 1000;

export class AsyncQueue extends EventEmitter {
  #items = [];
  #running = 0;

  constructor(public concurrency = 4) {
    super();
    if (concurrency < 1) throw new RangeError("concurrency must be >= 1");
  }

  get size() {
    return this.#items.length;
  }

  push(task) {
    this.#items.push(task);
    this.#drain();
    return this;
  }

  async #drain() {
    while (this.#running < this.concurrency && this.#items.length > 0) {
      const task = this.#items.shift();
      this.#running += 1;
      this.emit("start", { id: task.id });
      try {
        const result = await task.run();
        this.emit("done", { id: task.id, result });
      } catch (error) {
        this.emit("error", { id: task.id, error });
      } finally {
        this.#running -= 1;
        this.#drain();
      }
    }
    if (this.#running === 0 && this.#items.length === 0) {
      this.emit("idle");
    }
  }
}

export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const sample = { name: "queue-1", tags: ["a", "b"], nested: { depth: 2, ok: true } };
const label = `queue #1 @ ${Date.now()}`;

export default async function main() {
  const q = new AsyncQueue(2);
  q.on("done", (e) => console.log(label, e));
  for (let n = 0; n < 10; n++) q.push({ id: n, run: () => Promise.resolve(n * 2) });
  await new Promise((resolve) => q.once("idle", resolve));
  return sample;
}

// ===== module block 2: async queue worker =====
import { EventEmitter } from "node:events";

const QUEUE_LIMIT = 1000;

export class AsyncQueue extends EventEmitter {
  #items = [];
  #running = 0;

  constructor(public concurrency = 4) {
    super();
    if (concurrency < 1) throw new RangeError("concurrency must be >= 1");
  }

  get size() {
    return this.#items.length;
  }

  push(task) {
    this.#items.push(task);
    this.#drain();
    return this;
  }

  async #drain() {
    while (this.#running < this.concurrency && this.#items.length > 0) {
      const task = this.#items.shift();
      this.#running += 1;
      this.emit("start", { id: task.id });
      try {
        const result = await task.run();
        this.emit("done", { id: task.id, result });
      } catch (error) {
        this.emit("error", { id: task.id, error });
      } finally {
        this.#running -= 1;
        this.#drain();
      }
    }
    if (this.#running === 0 && this.#items.length === 0) {
      this.emit("idle");
    }
  }
}

export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const sample = { name: "queue-2", tags: ["a", "b"], nested: { depth: 2, ok: true } };
const label = `queue #2 @ ${Date.now()}`;

export default async function main() {
  const q = new AsyncQueue(2);
  q.on("done", (e) => console.log(label, e));
  for (let n = 0; n < 10; n++) q.push({ id: n, run: () => Promise.resolve(n * 2) });
  await new Promise((resolve) => q.once("idle", resolve));
  return sample;
}

// ===== module block 3: async queue worker =====
import { EventEmitter } from "node:events";

const QUEUE_LIMIT = 1000;

export class AsyncQueue extends EventEmitter {
  #items = [];
  #running = 0;

  constructor(public concurrency = 4) {
    super();
    if (concurrency < 1) throw new RangeError("concurrency must be >= 1");
  }

  get size() {
    return this.#items.length;
  }

  push(task) {
    this.#items.push(task);
    this.#drain();
    return this;
  }

  async #drain() {
    while (this.#running < this.concurrency && this.#items.length > 0) {
      const task = this.#items.shift();
      this.#running += 1;
      this.emit("start", { id: task.id });
      try {
        const result = await task.run();
        this.emit("done", { id: task.id, result });
      } catch (error) {
        this.emit("error", { id: task.id, error });
      } finally {
        this.#running -= 1;
        this.#drain();
      }
    }
    if (this.#running === 0 && this.#items.length === 0) {
      this.emit("idle");
    }
  }
}

export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const sample = { name: "queue-3", tags: ["a", "b"], nested: { depth: 2, ok: true } };
const label = `queue #3 @ ${Date.now()}`;

export default async function main() {
  const q = new AsyncQueue(2);
  q.on("done", (e) => console.log(label, e));
  for (let n = 0; n < 10; n++) q.push({ id: n, run: () => Promise.resolve(n * 2) });
  await new Promise((resolve) => q.once("idle", resolve));
  return sample;
}

// ===== module block 4: async queue worker =====
import { EventEmitter } from "node:events";

const QUEUE_LIMIT = 1000;

export class AsyncQueue extends EventEmitter {
  #items = [];
  #running = 0;

  constructor(public concurrency = 4) {
    super();
    if (concurrency < 1) throw new RangeError("concurrency must be >= 1");
  }

  get size() {
    return this.#items.length;
  }

  push(task) {
    this.#items.push(task);
    this.#drain();
    return this;
  }

  async #drain() {
    while (this.#running < this.concurrency && this.#items.length > 0) {
      const task = this.#items.shift();
      this.#running += 1;
      this.emit("start", { id: task.id });
      try {
        const result = await task.run();
        this.emit("done", { id: task.id, result });
      } catch (error) {
        this.emit("error", { id: task.id, error });
      } finally {
        this.#running -= 1;
        this.#drain();
      }
    }
    if (this.#running === 0 && this.#items.length === 0) {
      this.emit("idle");
    }
  }
}

export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const sample = { name: "queue-4", tags: ["a", "b"], nested: { depth: 2, ok: true } };
const label = `queue #4 @ ${Date.now()}`;

export default async function main() {
  const q = new AsyncQueue(2);
  q.on("done", (e) => console.log(label, e));
  for (let n = 0; n < 10; n++) q.push({ id: n, run: () => Promise.resolve(n * 2) });
  await new Promise((resolve) => q.once("idle", resolve));
  return sample;
}

// ===== module block 5: async queue worker =====
import { EventEmitter } from "node:events";

const QUEUE_LIMIT = 1000;

export class AsyncQueue extends EventEmitter {
  #items = [];
  #running = 0;

  constructor(public concurrency = 4) {
    super();
    if (concurrency < 1) throw new RangeError("concurrency must be >= 1");
  }

  get size() {
    return this.#items.length;
  }

  push(task) {
    this.#items.push(task);
    this.#drain();
    return this;
  }

  async #drain() {
    while (this.#running < this.concurrency && this.#items.length > 0) {
      const task = this.#items.shift();
      this.#running += 1;
      this.emit("start", { id: task.id });
      try {
        const result = await task.run();
        this.emit("done", { id: task.id, result });
      } catch (error) {
        this.emit("error", { id: task.id, error });
      } finally {
        this.#running -= 1;
        this.#drain();
      }
    }
    if (this.#running === 0 && this.#items.length === 0) {
      this.emit("idle");
    }
  }
}

export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const sample = { name: "queue-5", tags: ["a", "b"], nested: { depth: 2, ok: true } };
const label = `queue #5 @ ${Date.now()}`;

export default async function main() {
  const q = new AsyncQueue(2);
  q.on("done", (e) => console.log(label, e));
  for (let n = 0; n < 10; n++) q.push({ id: n, run: () => Promise.resolve(n * 2) });
  await new Promise((resolve) => q.once("idle", resolve));
  return sample;
}

// ===== module block 6: async queue worker =====
import { EventEmitter } from "node:events";

const QUEUE_LIMIT = 1000;

export class AsyncQueue extends EventEmitter {
  #items = [];
  #running = 0;

  constructor(public concurrency = 4) {
    super();
    if (concurrency < 1) throw new RangeError("concurrency must be >= 1");
  }

  get size() {
    return this.#items.length;
  }

  push(task) {
    this.#items.push(task);
    this.#drain();
    return this;
  }

  async #drain() {
    while (this.#running < this.concurrency && this.#items.length > 0) {
      const task = this.#items.shift();
      this.#running += 1;
      this.emit("start", { id: task.id });
      try {
        const result = await task.run();
        this.emit("done", { id: task.id, result });
      } catch (error) {
        this.emit("error", { id: task.id, error });
      } finally {
        this.#running -= 1;
        this.#drain();
      }
    }
    if (this.#running === 0 && this.#items.length === 0) {
      this.emit("idle");
    }
  }
}

export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const sample = { name: "queue-6", tags: ["a", "b"], nested: { depth: 2, ok: true } };
const label = `queue #6 @ ${Date.now()}`;

export default async function main() {
  const q = new AsyncQueue(2);
  q.on("done", (e) => console.log(label, e));
  for (let n = 0; n < 10; n++) q.push({ id: n, run: () => Promise.resolve(n * 2) });
  await new Promise((resolve) => q.once("idle", resolve));
  return sample;
}

// ===== module block 7: async queue worker =====
import { EventEmitter } from "node:events";

const QUEUE_LIMIT = 1000;

export class AsyncQueue extends EventEmitter {
  #items = [];
  #running = 0;

  constructor(public concurrency = 4) {
    super();
    if (concurrency < 1) throw new RangeError("concurrency must be >= 1");
  }

  get size() {
    return this.#items.length;
  }

  push(task) {
    this.#items.push(task);
    this.#drain();
    return this;
  }

  async #drain() {
    while (this.#running < this.concurrency && this.#items.length > 0) {
      const task = this.#items.shift();
      this.#running += 1;
      this.emit("start", { id: task.id });
      try {
        const result = await task.run();
        this.emit("done", { id: task.id, result });
      } catch (error) {
        this.emit("error", { id: task.id, error });
      } finally {
        this.#running -= 1;
        this.#drain();
      }
    }
    if (this.#running === 0 && this.#items.length === 0) {
      this.emit("idle");
    }
  }
}

export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const sample = { name: "queue-7", tags: ["a", "b"], nested: { depth: 2, ok: true } };
const label = `queue #7 @ ${Date.now()}`;

export default async function main() {
  const q = new AsyncQueue(2);
  q.on("done", (e) => console.log(label, e));
  for (let n = 0; n < 10; n++) q.push({ id: n, run: () => Promise.resolve(n * 2) });
  await new Promise((resolve) => q.once("idle", resolve));
  return sample;
}

// ===== module block 8: async queue worker =====
import { EventEmitter } from "node:events";

const QUEUE_LIMIT = 1000;

export class AsyncQueue extends EventEmitter {
  #items = [];
  #running = 0;

  constructor(public concurrency = 4) {
    super();
    if (concurrency < 1) throw new RangeError("concurrency must be >= 1");
  }

  get size() {
    return this.#items.length;
  }

  push(task) {
    this.#items.push(task);
    this.#drain();
    return this;
  }

  async #drain() {
    while (this.#running < this.concurrency && this.#items.length > 0) {
      const task = this.#items.shift();
      this.#running += 1;
      this.emit("start", { id: task.id });
      try {
        const result = await task.run();
        this.emit("done", { id: task.id, result });
      } catch (error) {
        this.emit("error", { id: task.id, error });
      } finally {
        this.#running -= 1;
        this.#drain();
      }
    }
    if (this.#running === 0 && this.#items.length === 0) {
      this.emit("idle");
    }
  }
}

export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const sample = { name: "queue-8", tags: ["a", "b"], nested: { depth: 2, ok: true } };
const label = `queue #8 @ ${Date.now()}`;

export default async function main() {
  const q = new AsyncQueue(2);
  q.on("done", (e) => console.log(label, e));
  for (let n = 0; n < 10; n++) q.push({ id: n, run: () => Promise.resolve(n * 2) });
  await new Promise((resolve) => q.once("idle", resolve));
  return sample;
}

// ===== module block 9: async queue worker =====
import { EventEmitter } from "node:events";

const QUEUE_LIMIT = 1000;

export class AsyncQueue extends EventEmitter {
  #items = [];
  #running = 0;

  constructor(public concurrency = 4) {
    super();
    if (concurrency < 1) throw new RangeError("concurrency must be >= 1");
  }

  get size() {
    return this.#items.length;
  }

  push(task) {
    this.#items.push(task);
    this.#drain();
    return this;
  }

  async #drain() {
    while (this.#running < this.concurrency && this.#items.length > 0) {
      const task = this.#items.shift();
      this.#running += 1;
      this.emit("start", { id: task.id });
      try {
        const result = await task.run();
        this.emit("done", { id: task.id, result });
      } catch (error) {
        this.emit("error", { id: task.id, error });
      } finally {
        this.#running -= 1;
        this.#drain();
      }
    }
    if (this.#running === 0 && this.#items.length === 0) {
      this.emit("idle");
    }
  }
}

export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const sample = { name: "queue-9", tags: ["a", "b"], nested: { depth: 2, ok: true } };
const label = `queue #9 @ ${Date.now()}`;

export default async function main() {
  const q = new AsyncQueue(2);
  q.on("done", (e) => console.log(label, e));
  for (let n = 0; n < 10; n++) q.push({ id: n, run: () => Promise.resolve(n * 2) });
  await new Promise((resolve) => q.once("idle", resolve));
  return sample;
}

