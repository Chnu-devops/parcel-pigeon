import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import httpProxy from '@fastify/http-proxy';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { metricsPlugin } from './plugins/metrics.js';

//make some comment to bump version
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

  // Edge -> service routing. Each upstream keeps its own path space; the gateway
  // just strips the /api/<area> prefix.
  await app.register(httpProxy, {
    upstream: config.SHIPMENTS_URL,
    prefix: '/api/shipments',
    rewritePrefix: '/shipments',
  });
  await app.register(httpProxy, {
    upstream: config.TRACKING_URL,
    prefix: '/api/track',
    rewritePrefix: '/track',
  });
  await app.register(httpProxy, {
    upstream: config.TRACKING_URL,
    prefix: '/api/notifications',
    rewritePrefix: '/notifications',
  });

  return app;
}
