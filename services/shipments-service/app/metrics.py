from __future__ import annotations

import logging
import time

from prometheus_client import Counter, Histogram
from starlette.types import ASGIApp, Message, Receive, Scope, Send

REQUESTS = Counter(
    "http_requests_total",
    "HTTP requests handled",
    ["method", "path", "status"],
)
LATENCY = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency",
    ["method", "path"],
)
access_log = logging.getLogger("shipments.access")

SHIPMENTS_CREATED = Counter("shipments_created_total", "Shipments created")
STATUS_CHANGED = Counter(
    "shipment_status_changed_total", "Shipment status changes", ["status"]
)
EVENTS_PUBLISHED = Counter(
    "shipment_events_published_total", "Domain events published", ["routing_key", "outcome"]
)


class MetricsMiddleware:
    """Tiny ASGI middleware: RED metrics keyed by route template + one access-log
    line per request, carrying the gateway's x-request-id."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope["method"]
        start = time.perf_counter()
        status_holder = {"code": 500}

        async def _send(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["code"] = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, _send)
        finally:
            route = scope.get("route")
            path = getattr(route, "path", scope["path"])
            elapsed = time.perf_counter() - start
            status = status_holder["code"]
            LATENCY.labels(method, path).observe(elapsed)
            REQUESTS.labels(method, path, str(status)).inc()
            if path != "/metrics":
                headers = dict(scope.get("headers") or [])
                access_log.log(
                    logging.ERROR if status >= 500 else logging.INFO,
                    "request completed",
                    extra={
                        "method": method,
                        "path": scope["path"],
                        "route": path,
                        "status": status,
                        "duration_ms": round(elapsed * 1000, 1),
                        "request_id": headers.get(b"x-request-id", b"").decode() or None,
                    },
                )
