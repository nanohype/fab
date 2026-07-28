/**
 * Webhook delivery tests.
 *
 * `deliverResult` runs after a workflow has already finished, against a URL the
 * operator supplied. Its contract is that it never throws — a black-holing or
 * 500-ing endpoint must not turn a completed run into a failed one, because
 * the work is done and the exit code is the only thing left to get wrong.
 *
 * Driven against a real `node:http` listener so the request that arrives is
 * the request `fetch` actually sent.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverResult } from '../src/webhook.js';

const PAYLOAD = {
  session_id: 'sess_1',
  status: 'complete' as const,
  output: 'the workflow output',
  cost: 1.23,
};

let server: Server | undefined;

interface Received {
  method?: string;
  contentType?: string;
  body?: string;
}

async function listen(handler: (received: Received) => { status: number; body: string }) {
  const received: Received = {};
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.method = req.method;
      received.contentType = req.headers['content-type'];
      received.body = Buffer.concat(chunks).toString('utf-8');
      const { status, body } = handler(received);
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const { port } = server!.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/hook`, received };
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe('deliverResult', () => {
  it('POSTs the payload as JSON', async () => {
    const { url, received } = await listen(() => ({ status: 200, body: 'ok' }));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await deliverResult(url, PAYLOAD);

    expect(received.method).toBe('POST');
    expect(received.contentType).toBe('application/json');
    expect(JSON.parse(received.body!)).toEqual(PAYLOAD);
  });

  it('logs the delivery on success', async () => {
    const { url } = await listen(() => ({ status: 202, body: 'accepted' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await deliverResult(url, PAYLOAD);

    expect(log.mock.calls.flat().join(' ')).toContain('202');
  });

  it('reports a non-2xx response without throwing', async () => {
    // The run already succeeded. Throwing here would report a failed workflow
    // because someone's webhook endpoint was down.
    const { url } = await listen(() => ({ status: 500, body: 'upstream exploded' }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(deliverResult(url, PAYLOAD)).resolves.toBeUndefined();

    const logged = error.mock.calls.flat().join(' ');
    expect(logged).toContain('500');
    expect(logged).toContain('upstream exploded');
  });

  it('swallows a connection failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Port 1 on loopback refuses immediately.
    await expect(deliverResult('http://127.0.0.1:1/hook', PAYLOAD)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalled();
  });

  it('swallows a malformed URL', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(deliverResult('not-a-url', PAYLOAD)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalled();
  });
});
