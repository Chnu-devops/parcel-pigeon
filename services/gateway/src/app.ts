import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import httpProxy from '@fastify/http-proxy';
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Config } from './config.js';
import { metricsPlugin } from './plugins/metrics.js';

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
    disableRequestLogging: false,
  });

  await app.register(cors, { origin: true });
  await app.register(metricsPlugin);

  // Propagate the request id back to the caller and down to upstreams.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // Fault switch (ERROR_RATE): fail a share of /api calls on purpose, so a
  // "bad release" shows up in metrics, alerts and the canary analysis.
  // Probes and /metrics are never touched — the pod itself stays healthy.
  app.addHook('onRequest', async (req, reply) => {
    if (config.ERROR_RATE <= 0 || !req.url.startsWith('/api/')) return;
    if (Math.random() >= config.ERROR_RATE) return;
    req.log.error({ errorRate: config.ERROR_RATE }, 'injected fault');
    return reply.code(500).send({ error: 'injected fault (ERROR_RATE)' });
  });

  // Stub auth: guard mutating calls only. A real gateway would verify a JWT here.
  app.addHook('preHandler', async (req, reply) => {
    if (!config.GATEWAY_API_KEY) return;
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (!req.url.startsWith('/api/')) return;
    if (req.headers['x-api-key'] !== config.GATEWAY_API_KEY) {
      reply.code(401).send({ error: 'missing or invalid x-api-key' });
    }
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const upstreams: Record<string, string> = {
      'shipments-service': `${config.SHIPMENTS_URL}/healthz`,
      'tracking-service': `${config.TRACKING_URL}/healthz`,
    };
    const checks: Record<string, boolean> = {};
    await Promise.all(
      Object.entries(upstreams).map(async ([name, url]) => {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
          checks[name] = res.ok;
        } catch {
          checks[name] = false;
        }
      }),
    );
    const ready = Object.values(checks).every(Boolean);
    reply.code(ready ? 200 : 503);
    return { ready, checks };
  });

  // Send our request id upstream too (also when we generated it), so one id
  // finds the same request in the logs of every service.
  const replyOptions = {
    rewriteRequestHeaders: (req: { id: string }, headers: IncomingHttpHeaders) => ({
      ...headers,
      'x-request-id': req.id,
    }),
  };

  // Edge -> service routing. Each upstream keeps its own path space; the gateway
  // just strips the /api/<area> prefix.
  await app.register(httpProxy, {
    upstream: config.SHIPMENTS_URL,
    prefix: '/api/shipments',
    rewritePrefix: '/shipments',
    replyOptions,
  });
  await app.register(httpProxy, {
    upstream: config.TRACKING_URL,
    prefix: '/api/track',
    rewritePrefix: '/track',
    replyOptions,
  });
  await app.register(httpProxy, {
    upstream: config.TRACKING_URL,
    prefix: '/api/notifications',
    rewritePrefix: '/notifications',
    replyOptions,
  });

  return app;
}
