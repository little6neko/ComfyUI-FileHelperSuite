from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
import types
from pathlib import Path


def test_package_exports_node_and_registers_routes(monkeypatch, tmp_path):
    registered_routes = {}

    class FakeRoutes:
        def get(self, path):
            def decorator(handler):
                registered_routes[path] = handler
                return handler

            return decorator

    class FakeResponse:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    fake_web = types.SimpleNamespace(
        Request=object,
        Response=FakeResponse,
        json_response=lambda *args, **kwargs: FakeResponse(
            args=args, **kwargs
        ),
    )
    fake_aiohttp = types.ModuleType("aiohttp")
    fake_aiohttp.web = fake_web

    fake_comfy_server = types.ModuleType("server")
    fake_comfy_server.PromptServer = type(
        "PromptServer",
        (),
        {
            "instance": type(
                "PromptServerInstance", (), {"routes": FakeRoutes()}
            )()
        },
    )

    monkeypatch.setitem(sys.modules, "aiohttp", fake_aiohttp)
    monkeypatch.setitem(sys.modules, "server", fake_comfy_server)

    root = Path(__file__).resolve().parents[1]
    package_name = "fhs_registration_under_test"
    spec = importlib.util.spec_from_file_location(
        package_name,
        root / "__init__.py",
        submodule_search_locations=[str(root)],
    )
    assert spec is not None and spec.loader is not None
    package = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, package_name, package)
    spec.loader.exec_module(package)

    assert package.WEB_DIRECTORY == "./web"
    assert set(package.NODE_CLASS_MAPPINGS) == {"FHS_LoadImagePath"}
    assert package.NODE_DISPLAY_NAME_MAPPINGS == {
        "FHS_LoadImagePath": "Load Image (Path)"
    }
    assert set(registered_routes) == {
        "/fhs/list-path",
        "/fhs/view-image",
    }

    request = types.SimpleNamespace(
        rel_url=types.SimpleNamespace(query={"path": str(tmp_path)})
    )
    response = asyncio.run(registered_routes["/fhs/list-path"](request))
    listing = response.kwargs["args"][0]
    assert listing["directory"] == f"{tmp_path}{os.sep}"
    assert listing["value"] == f"{tmp_path}{os.sep}"
    assert response.kwargs["headers"] == {"Cache-Control": "no-store"}

    missing_request = types.SimpleNamespace(
        rel_url=types.SimpleNamespace(
            query={"path": str(tmp_path / "missing" / "partial")}
        )
    )
    missing_response = asyncio.run(
        registered_routes["/fhs/list-path"](missing_request)
    )
    assert missing_response.kwargs["status"] == 404
    assert "does not exist" in missing_response.kwargs["args"][0]["error"]

    invalid_request = types.SimpleNamespace(
        rel_url=types.SimpleNamespace(query={"path": "bad\0path"})
    )
    invalid_response = asyncio.run(
        registered_routes["/fhs/list-path"](invalid_request)
    )
    assert invalid_response.kwargs["status"] == 400

    with monkeypatch.context() as context:
        context.setattr(
            package._server,
            "list_image_paths",
            lambda _path: (_ for _ in ()).throw(PermissionError("denied")),
        )
        denied_response = asyncio.run(
            registered_routes["/fhs/list-path"](request)
        )
    assert denied_response.kwargs["status"] == 403
    assert denied_response.kwargs["args"][0] == {"error": "denied"}
