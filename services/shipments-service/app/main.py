from __future__ import annotations

from fastapi import FastAPI
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from starlette.responses import Response

from app.broker import close as close_broker
from app.config import get_settings
from app.logs import setup_logging
from app.metrics import MetricsMiddleware
from app.routers import health, shipments

settings = get_settings()
setup_logging(settings.log_level)

app = FastAPI(title="ParcelPigeon shipments-service", version="0.1.0")
app.add_middleware(MetricsMiddleware)
app.include_router(health.router)
app.include_router(shipments.router)


@app.get("/metrics")
def metrics() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.on_event("shutdown")
def _shutdown() -> None:
    close_broker()
