from __future__ import annotations

import os

import pytest
from PIL import Image


def entry_names(listing, kind):
    return [
        entry["name"]
        for entry in listing["entries"]
        if entry["kind"] == kind
    ]


def test_empty_path_starts_in_working_directory(
    loader_module, tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)

    listing = loader_module.list_image_paths("")

    assert listing["directory"] == str(tmp_path)
    assert listing["remainder"] == ""
    assert listing["parent"] == str(tmp_path.parent)


def test_listing_filters_images_and_sorts_directories_first(
    loader_module, tmp_path
):
    (tmp_path / "z-folder").mkdir()
    (tmp_path / "A-folder").mkdir()
    Image.new("RGB", (8, 8)).save(tmp_path / "z-image.PNG")
    Image.new("RGB", (8, 8)).save(tmp_path / "a-image.jpg")
    (tmp_path / "notes.txt").write_text("not an image", encoding="utf-8")

    listing = loader_module.list_image_paths(str(tmp_path))

    assert entry_names(listing, "directory") == ["A-folder", "z-folder"]
    assert entry_names(listing, "file") == ["a-image.jpg", "z-image.PNG"]
    assert [entry["kind"] for entry in listing["entries"]] == [
        "directory",
        "directory",
        "file",
        "file",
    ]


def test_existing_file_opens_parent_with_filename_remainder(
    loader_module, tmp_path
):
    image_path = tmp_path / "selected.image.png"
    Image.new("RGB", (8, 8)).save(image_path)

    listing = loader_module.list_image_paths(f'  "{image_path}"  ')

    assert listing["directory"] == str(tmp_path)
    assert listing["remainder"] == image_path.name
    assert entry_names(listing, "file") == [image_path.name]


def test_partial_relative_path_uses_existing_parent(
    loader_module, tmp_path, monkeypatch
):
    images = tmp_path / "images"
    images.mkdir()
    monkeypatch.chdir(tmp_path)

    listing = loader_module.list_image_paths("images/dra")

    assert listing["directory"] == str(images)
    assert listing["remainder"] == "dra"
    assert listing["parent"] == str(tmp_path)


def test_trailing_separator_treats_missing_path_as_directory(
    loader_module, tmp_path
):
    missing = tmp_path / "missing"

    with pytest.raises(FileNotFoundError, match="Directory does not exist"):
        loader_module.list_image_paths(str(missing) + os.sep)


def test_missing_partial_parent_is_reported(loader_module, tmp_path):
    missing = tmp_path / "missing" / "image"

    with pytest.raises(FileNotFoundError, match="Directory does not exist"):
        loader_module.list_image_paths(str(missing))


def test_file_cannot_be_used_as_partial_parent(loader_module, tmp_path):
    blocking_file = tmp_path / "blocking-file"
    blocking_file.write_text("not a directory", encoding="utf-8")

    with pytest.raises(FileNotFoundError, match="Directory does not exist"):
        loader_module.list_image_paths(str(blocking_file / "image.png"))


def test_invalid_path_is_bounded(loader_module):
    with pytest.raises(loader_module.ImagePathError, match="invalid"):
        loader_module.list_image_paths("bad\0path")


def test_permission_error_is_preserved(loader_module, tmp_path, monkeypatch):
    def deny_scan(_path):
        raise PermissionError("denied")

    monkeypatch.setattr(loader_module.os, "scandir", deny_scan)

    with pytest.raises(PermissionError, match="not accessible"):
        loader_module.list_image_paths(str(tmp_path))


def test_broken_directory_entry_is_skipped(loader_module, tmp_path, monkeypatch):
    class BrokenEntry:
        name = "broken.png"
        path = str(tmp_path / name)

        def is_dir(self):
            raise OSError("entry disappeared")

    class GoodEntry:
        name = "good.png"
        path = str(tmp_path / name)

        def is_dir(self):
            return False

        def is_file(self):
            return True

    class FakeScandir:
        def __enter__(self):
            return iter([BrokenEntry(), GoodEntry()])

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(loader_module.os, "scandir", lambda _path: FakeScandir())

    listing = loader_module.list_image_paths(str(tmp_path))

    assert entry_names(listing, "file") == ["good.png"]


def test_filesystem_root_has_no_parent(loader_module):
    root = os.path.abspath(os.sep)

    assert loader_module._browser_parent(root) is None
