from __future__ import annotations

import io

import pytest
from PIL import Image


def decode_preview(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    image.load()
    return image


def test_preview_is_reencoded_and_capped(loader_module, tmp_path):
    path = tmp_path / "wide.png"
    Image.new("RGB", (400, 100), (10, 20, 30)).save(path)

    data = loader_module.render_preview_png(str(path), max_edge=256)
    preview = decode_preview(data)

    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    assert preview.size == (256, 67)
    assert preview.format == "PNG"


def test_preview_uses_forced_output_aspect(loader_module, tmp_path):
    path = tmp_path / "wide.png"
    Image.new("RGB", (400, 100), (10, 20, 30)).save(path)

    data = loader_module.render_preview_png(str(path), 800, 800, max_edge=256)
    preview = decode_preview(data)

    assert preview.size == (256, 256)


def test_preview_preserves_alpha(loader_module, tmp_path):
    path = tmp_path / "alpha.png"
    Image.new("RGBA", (16, 16), (1, 2, 3, 64)).save(path)

    preview = decode_preview(loader_module.render_preview_png(str(path)))

    assert preview.mode == "RGBA"
    assert preview.getchannel("A").getextrema() == (64, 64)


def test_preview_rejects_non_image(loader_module, tmp_path):
    path = tmp_path / "notes.png"
    path.write_text("secret text", encoding="utf-8")

    with pytest.raises(loader_module.ImageDecodeError):
        loader_module.render_preview_png(str(path))


def test_preview_rejects_invalid_max_edge(loader_module, tmp_path):
    path = tmp_path / "valid.png"
    Image.new("RGB", (8, 8)).save(path)

    with pytest.raises(ValueError, match="positive integer"):
        loader_module.render_preview_png(str(path), max_edge=0)
