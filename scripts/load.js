// k6 load generator for the observability demo: steady, realistic traffic so
// the Grafana dashboard, the alerts and the gateway canary analysis have
// something to look at. Each iteration plays one parcel's life through the
// gateway: create → scans → public tracking → list.
//
//   ./scripts/dev.sh load                                     # dev.parcelpigeon.local, 5 VUs, 5m
//   BASE_URL=http://parcelpigeon.local VUS=10 DURATION=15m ./scripts/dev.sh load
//   BASE_URL=http://localhost:8000 ./scripts/dev.sh load      # a gateway on this machine
//
// Go through the Ingress, not `kubectl port-forward`: a port-forward pins
// every request to one pod, so a canary would get all traffic or none.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://dev.parcelpigeon.local';
const API_KEY = __ENV.GATEWAY_API_KEY || '';

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || '5m',
  // The run fails (exit code 99) when the gateway misbehaves — e.g. with
  // ERROR_RATE switched on. k6 keeps going until the end either way.
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<500'],
  },
};

const headers = { 'Content-Type': 'application/json' };
if (API_KEY) headers['x-api-key'] = API_KEY;

// Legal paths through the status machine (services/shipments-service/app/shipment_status.py).
const JOURNEYS = [
  ['PICKED_UP', 'ARRIVED_AT_FACILITY', 'OUT_FOR_DELIVERY', 'DELIVERED'],
  ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'],
  ['PICKED_UP', 'DELIVERY_FAILED'],
];
const CITIES = ['Kyiv', 'Lviv', 'Chernivtsi', 'Odesa', 'Kharkiv', 'Dnipro'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export default function () {
  const created = http.post(
    `${BASE_URL}/api/shipments`,
    JSON.stringify({
      recipient_name: `Load Tester ${__VU}`,
      recipient_email: `load-${__VU}@example.com`,
      origin: pick(CITIES),
      destination: pick(CITIES),
    }),
    { headers, tags: { name: 'POST /api/shipments' } },
  );
  if (!check(created, { 'shipment created': (r) => r.status === 201 })) {
    sleep(1);
    return;
  }
  const { id, tracking_number: tn } = created.json();

  for (const event of pick(JOURNEYS)) {
    const scan = http.post(
      `${BASE_URL}/api/shipments/${id}/scans`,
      JSON.stringify({ event_type: event, location: pick(CITIES) }),
      { headers, tags: { name: 'POST /api/shipments/:id/scans' } },
    );
    check(scan, { 'scan recorded': (r) => r.status === 201 });
    sleep(0.2);
  }

  // Public tracking: the read side, served by tracking-service from Redis.
  for (let i = 0; i < 3; i++) {
    const track = http.get(`${BASE_URL}/api/track/${tn}`, { tags: { name: 'GET /api/track/:tn' } });
    check(track, { 'tracking found': (r) => r.status === 200 });
    sleep(0.3);
  }

  const list = http.get(`${BASE_URL}/api/shipments`, { tags: { name: 'GET /api/shipments' } });
  check(list, { 'list ok': (r) => r.status === 200 });
  sleep(1);
}
