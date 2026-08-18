from __future__ import annotations

import asyncio
import logging

from aiohttp import web
from server import PromptServer

from .nodes.load_image_path import (
    MAX_CUSTOM_DIMENSION,
    ImageDecodeError,
    ImagePathError,
    UnsafeImageError,
    render_preview_png,
)


LOGGER = logging.getLogger(__name__)
PREVIEW_ROUTE = "/fhs/view-image"


def _query_dimension(request: web.Request, name: str) -> int:
    raw_value = request.rel_url.query.get(name, "0")
    try:
        value = int(raw_value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{name} must be an integer.") from exc
    if value < 0 or value > MAX_CUSTOM_DIMENSION:
        raise ValueError(
            f"{name} must be between 0 and {MAX_CUSTOM_DIMENSION}."
        )
    return value


def _error_response(message: str, status: int) -> web.Response:
    return web.json_response(
        {"error": message},
        status=status,
        headers={"Cache-Control": "no-store"},
    )


@PromptServer.instance.routes.get(PREVIEW_ROUTE)
async def view_image(request: web.Request) -> web.Response:
    image_path = request.rel_url.query.get("path", "")
    try:
        custom_width = _query_dimension(request, "custom_width")
        custom_height = _query_dimension(request, "custom_height")
        preview = await asyncio.to_thread(
            render_preview_png,
            image_path,
            custom_width,
            custom_height,
        )
    except ImagePathError as exc:
        status = 404 if "does not exist" in str(exc) else 400
        return _error_response(str(exc), status)
    except ImageDecodeError as exc:
        return _error_response(str(exc), 415)
    except UnsafeImageError as exc:
        return _error_response(str(exc), 413)
    except ValueError as exc:
        return _error_response(str(exc), 400)
    except Exception:
        LOGGER.exception("Unexpected Load Image (Path) preview failure")
        return _error_response("Unable to generate image preview.", 500)

    return web.Response(
        body=preview,
        content_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
