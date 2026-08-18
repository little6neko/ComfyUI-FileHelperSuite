from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


@pytest.fixture(scope="session")
def loader_module():
    module_path = (
        Path(__file__).resolve().parents[1] / "nodes" / "load_image_path.py"
    )
    spec = importlib.util.spec_from_file_location(
        "fhs_load_image_path_under_test", module_path
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
