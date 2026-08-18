from __future__ import annotations

import os
import time

import pytest
import torch
from PIL import Image


def test_calculate_target_size_modes(loader_module):
    calculate = loader_module.calculate_target_size

    assert calculate((101, 49), 0, 0) == (104, 48)
    assert calculate((101, 49), 80, 0) == (80, 40)
    assert calculate((101, 49), 0, 80) == (168, 80)
    assert calculate((101, 49), 80, 56) == (80, 56)
    assert calculate((1, 1), 0, 0) == (8, 8)


def test_target_size_rejects_unsafe_derived_edge(loader_module):
    with pytest.raises(loader_module.UnsafeImageError, match="safety limit"):
        loader_module.calculate_target_size((1, 10_000), 8192, 0)


def test_load_rgb_image_and_multidot_filename(loader_module, tmp_path):
    path = tmp_path / "draft.v2.png"
    Image.new("RGB", (17, 9), (255, 0, 0)).save(path)

    images, masks, filename = loader_module.load_image_file(str(path))

    assert images.shape == (1, 8, 16, 3)
    assert images.dtype == torch.float32
    assert torch.allclose(images[..., 0], torch.ones_like(images[..., 0]))
    assert torch.count_nonzero(images[..., 1:]) == 0
    assert masks.shape == (1, 64, 64)
    assert torch.count_nonzero(masks) == 0
    assert filename == "draft.v2"


def test_load_rgba_image_returns_inverted_alpha(loader_module, tmp_path):
    path = tmp_path / "alpha.png"
    image = Image.new("RGBA", (16, 8), (20, 40, 60, 64))
    image.save(path)

    images, masks, _ = loader_module.load_image_file(str(path))

    assert images.shape == (1, 8, 16, 3)
    assert masks.shape == (1, 8, 16)
    assert torch.allclose(
        masks,
        torch.full_like(masks, 1.0 - 64.0 / 255.0),
        atol=1e-6,
    )


def test_width_only_and_forced_ratio_resize(loader_module, tmp_path):
    path = tmp_path / "resize.png"
    Image.new("RGB", (20, 10), (1, 2, 3)).save(path)

    proportional, _, _ = loader_module.load_image_file(str(path), 40, 0)
    forced, _, _ = loader_module.load_image_file(str(path), 40, 40)

    assert proportional.shape == (1, 24, 40, 3)
    assert forced.shape == (1, 40, 40, 3)


def test_exif_orientation_is_applied(loader_module, tmp_path):
    path = tmp_path / "oriented.jpg"
    image = Image.new("RGB", (16, 8), (10, 20, 30))
    exif = Image.Exif()
    exif[274] = 6
    image.save(path, exif=exif)

    images, _, _ = loader_module.load_image_file(str(path))

    assert images.shape == (1, 16, 8, 3)


def test_animated_gif_becomes_image_batch(loader_module, tmp_path):
    path = tmp_path / "animated.gif"
    first = Image.new("RGB", (16, 16), (255, 0, 0))
    second = Image.new("RGB", (16, 16), (0, 255, 0))
    first.save(
        path,
        save_all=True,
        append_images=[second],
        duration=50,
        loop=0,
    )

    images, masks, _ = loader_module.load_image_file(str(path))

    assert images.shape == (2, 16, 16, 3)
    assert masks.shape[0] == 2
    assert torch.mean(images[0, ..., 0]) > 0.9
    assert torch.mean(images[1, ..., 1]) > 0.9


def test_animated_alpha_frames_have_stackable_masks(loader_module, tmp_path):
    path = tmp_path / "animated-alpha.png"
    first = Image.new("RGBA", (16, 16), (255, 0, 0, 255))
    second = Image.new("RGBA", (16, 16), (0, 255, 0, 64))
    first.save(
        path,
        save_all=True,
        append_images=[second],
        duration=50,
        loop=0,
    )

    images, masks, _ = loader_module.load_image_file(str(path))

    assert images.shape == (2, 16, 16, 3)
    assert masks.shape == (2, 16, 16)
    assert torch.count_nonzero(masks[0]) == 0
    assert torch.allclose(
        masks[1],
        torch.full_like(masks[1], 1.0 - 64.0 / 255.0),
        atol=1e-6,
    )


def test_normalize_quotes_relative_path_and_home(
    loader_module, tmp_path, monkeypatch
):
    image_path = tmp_path / "quoted.png"
    Image.new("RGB", (8, 8)).save(image_path)
    monkeypatch.chdir(tmp_path)

    assert loader_module.normalize_image_path('  "quoted.png"  ') == str(image_path)

    home_path = tmp_path / "home.png"
    Image.new("RGB", (8, 8)).save(home_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    assert loader_module.normalize_image_path("~/home.png") == str(home_path)


@pytest.mark.parametrize(
    ("kind", "expected"),
    [
        ("missing", "does not exist"),
        ("directory", "not a file"),
        ("corrupt", "Unsupported or invalid"),
    ],
)
def test_validation_errors(loader_module, tmp_path, kind, expected):
    if kind == "missing":
        path = tmp_path / "missing.png"
    elif kind == "directory":
        path = tmp_path / "folder"
        path.mkdir()
    else:
        path = tmp_path / "corrupt.png"
        path.write_text("not an image", encoding="utf-8")

    result = loader_module.LoadImagePath.VALIDATE_INPUTS(str(path), 0, 0)

    assert result is not True
    assert expected in result


def test_cache_token_changes_with_file_metadata(loader_module, tmp_path):
    path = tmp_path / "cache.png"
    Image.new("RGB", (8, 8), (1, 2, 3)).save(path)
    first = loader_module.change_token(str(path), 0, 0)

    time.sleep(0.002)
    Image.new("RGB", (16, 8), (4, 5, 6)).save(path)
    os.utime(path, None)
    second = loader_module.change_token(str(path), 0, 0)

    assert first != second
    assert second != loader_module.change_token(str(path), 16, 0)


def test_node_interface_has_no_vae(loader_module):
    inputs = loader_module.LoadImagePath.INPUT_TYPES()

    assert set(inputs) == {"required"}
    assert set(inputs["required"]) == {"image", "custom_width", "custom_height"}
    assert loader_module.LoadImagePath.RETURN_TYPES == ("IMAGE", "MASK", "STRING")
    assert loader_module.LoadImagePath.RETURN_NAMES == (
        "image",
        "mask",
        "filename",
    )
