// github-core-clone-01 entry: the process entrypoint.
// Binds an ephemeral port, registers it with the grading environment, then waits until the
// environment reports the trial is done. Node 22 standard library only.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { Store } from './store.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.error('MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const store = new Store();
  const server = createApp(store, token);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const port = address.port;

  // Register the port with the environment. A 409 means another registration won; retry with
  // backoff for a short while, then give up rather than hanging the trial. A transient network
  // failure is retried the same way instead of crashing the process.
  let registered = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let status = 0;
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      status = response.status;
    } catch {
      status = 0;
    }
    if (status === 200) {
      registered = true;
      break;
    }
    if (status !== 409 && status !== 0) {
      console.error(`register answered HTTP ${status}`);
      break;
    }
    await sleep(250 * (attempt + 1));
  }
  if (!registered) {
    console.error('could not register with the environment');
    server.close();
    process.exit(1);
  }

  // Long-poll the environment until the trial is done, then shut down cleanly.
  for (;;) {
    await sleep(500);
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) break;
      }
    } catch {
      // A transient environment hiccup must not kill the forge; keep polling.
    }
  }
  server.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
