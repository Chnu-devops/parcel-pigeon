import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/** Minimal stand-ins for shipments-service and tracking-service. */
async function startStubs(): Promise<{ url: string; stop: () => Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const stub: FastifyInstance = Fastify();

  stub.all('/*', async (req) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === '/healthz') return { status: 'ok' };
    if (req.url.startsWith('/shipments'))
      return { proxied: 'shipments', url: req.url, requestId: req.headers['x-request-id'] };
    if (req.url.startsWith('/track')) return { proxied: 'tracking', url: req.url };
    if (req.url.startsWith('/notifications')) return [{ to: 'ada@example.com' }];
    return { ok: true };
  });

  const url = await stub.listen({ port: 0, host: '127.0.0.1' });
  return { url, stop: () => stub.close(), hits };
}

describe('gateway', () => {
  let stubs: Awaited<ReturnType<typeof startStubs>>;
  let app: FastifyInstance;
  let appWithAuth: FastifyInstance;
  let appFaulty: FastifyInstance;

  beforeAll(async () => {
    stubs = await startStubs();
    const base = {
      SHIPMENTS_URL: stubs.url,
      TRACKING_URL: stubs.url,
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv;
    app = await buildApp(loadConfig(base));
    appWithAuth = await buildApp(loadConfig({ ...base, GATEWAY_API_KEY: 'secret' }));
    appFaulty = await buildApp(loadConfig({ ...base, ERROR_RATE: '1' }));
  });

  afterAll(async () => {
    await app.close();
    await appWithAuth.close();
    await appFaulty.close();
    await stubs.stop();
  });

  it('proxies /api/shipments to the shipments upstream with rewritten prefix', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/shipments' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ proxied: 'shipments', url: '/shipments' });
  });

  it('proxies /api/track/:tn to the tracking upstream', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/track/PP-DEMO0001' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ proxied: 'tracking', url: '/track/PP-DEMO0001' });
  });

  it('returns a x-request-id header', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('forwards the request id to upstreams', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/shipments' });
    expect(res.json().requestId).toBe(res.headers['x-request-id']);
  });

  it('fails /api calls when ERROR_RATE=1 but keeps probes healthy', async () => {
    const api = await appFaulty.inject({ method: 'GET', url: '/api/shipments' });
    expect(api.statusCode).toBe(500);
    const health = await appFaulty.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
  });

  it('aggregates upstream health in /readyz', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ready: true,
      checks: { 'shipments-service': true, 'tracking-service': true },
    });
  });

  it('exposes Prometheus metrics', async () => {
    await app.inject({ method: 'GET', url: '/healthz' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('http_requests_total');
  });

  it('rejects mutating /api calls without the api key when one is configured', async () => {
    const res = await appWithAuth.inject({
      method: 'POST',
      url: '/api/shipments',
      payload: { recipient_name: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows mutating /api calls with the correct api key', async () => {
    const res = await appWithAuth.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { 'x-api-key': 'secret' },
      payload: { recipient_name: 'x' },
    });
    expect(res.statusCode).toBe(200);
  });
});
