from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path


def test_package_exports_node_and_registers_preview_route(monkeypatch):
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
    assert set(registered_routes) == {"/fhs/view-image"}
