from __future__ import annotations

import os

import pytest
from PIL import Image


def entries_of_kind(listing, kind):
    return [
        entry for entry in listing["entries"] if entry["kind"] == kind
    ]


def entry_names(listing, kind):
    return [entry["name"] for entry in entries_of_kind(listing, kind)]


def entry_by_name(listing, name):
    return next(entry for entry in listing["entries"] if entry["name"] == name)


def test_browser_root_tracks_process_working_directory(
    loader_module, tmp_path, monkeypatch
):
    root = tmp_path / "ComfyUI"
    root.mkdir()
    monkeypatch.chdir(root)

    assert loader_module._browser_root() == str(root)


def test_empty_path_represents_working_directory_as_empty_value(
    loader_module, tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)

    listing = loader_module.list_image_paths("")

    assert listing["directory"] == ""
    assert listing["value"] == ""
    assert listing["remainder"] == ""
    assert listing["parent"] is None


def test_root_listing_filters_images_and_returns_relative_paths(
    loader_module, tmp_path, monkeypatch
):
    (tmp_path / "z-folder").mkdir()
    (tmp_path / "A-folder").mkdir()
    Image.new("RGB", (8, 8)).save(tmp_path / "z-image.PNG")
    Image.new("RGB", (8, 8)).save(tmp_path / "a-image.jpg")
    (tmp_path / "notes.txt").write_text("not an image", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    listing = loader_module.list_image_paths("")

    assert entry_names(listing, "directory") == ["A-folder", "z-folder"]
    assert entry_names(listing, "file") == ["a-image.jpg", "z-image.PNG"]
    assert [entry["kind"] for entry in listing["entries"]] == [
        "directory",
        "directory",
        "file",
        "file",
    ]
    assert entry_by_name(listing, "A-folder")["path"] == (
        f"A-folder{os.sep}"
    )
    assert entry_by_name(listing, "a-image.jpg")["path"] == "a-image.jpg"


def test_legacy_absolute_root_file_is_canonicalized_to_relative(
    loader_module, tmp_path, monkeypatch
):
    images = tmp_path / "input"
    images.mkdir()
    image_path = images / "selected.image.png"
    Image.new("RGB", (8, 8)).save(image_path)
    monkeypatch.chdir(tmp_path)

    listing = loader_module.list_image_paths(f'  "{image_path}"  ')

    relative_directory = f"input{os.sep}"
    relative_file = f"{relative_directory}{image_path.name}"
    assert listing["directory"] == relative_directory
    assert listing["value"] == relative_file
    assert listing["remainder"] == image_path.name
    assert listing["parent"] == ""
    assert entry_by_name(listing, image_path.name)["path"] == relative_file


def test_partial_relative_path_uses_existing_parent(
    loader_module, tmp_path, monkeypatch
):
    images = tmp_path / "images"
    images.mkdir()
    monkeypatch.chdir(tmp_path)

    listing = loader_module.list_image_paths("images/dra")

    assert listing["directory"] == f"images{os.sep}"
    assert listing["value"] == f"images{os.sep}dra"
    assert listing["remainder"] == "dra"
    assert listing["parent"] == ""


def test_nested_parent_navigation_stops_at_browser_root(
    loader_module, tmp_path, monkeypatch
):
    nested = tmp_path / "models" / "reference"
    nested.mkdir(parents=True)
    monkeypatch.chdir(tmp_path)

    nested_listing = loader_module.list_image_paths(
        f"models{os.sep}reference{os.sep}"
    )
    models_listing = loader_module.list_image_paths(f"models{os.sep}")
    root_listing = loader_module.list_image_paths("")

    assert nested_listing["directory"] == (
        f"models{os.sep}reference{os.sep}"
    )
    assert nested_listing["parent"] == f"models{os.sep}"
    assert models_listing["parent"] == ""
    assert root_listing["parent"] is None


def test_outside_root_paths_remain_absolute(
    loader_module, tmp_path, monkeypatch
):
    root = tmp_path / "ComfyUI"
    outside = tmp_path / "ComfyUI-other"
    root.mkdir()
    outside.mkdir()
    image_path = outside / "external.png"
    Image.new("RGB", (8, 8)).save(image_path)
    monkeypatch.chdir(root)

    listing = loader_module.list_image_paths(str(image_path))

    outside_directory = f"{outside}{os.sep}"
    assert listing["directory"] == outside_directory
    assert listing["value"] == str(image_path)
    assert listing["parent"] == f"{tmp_path}{os.sep}"
    assert entry_by_name(listing, image_path.name)["path"] == str(image_path)


def test_commonpath_failure_falls_back_to_absolute_value(
    loader_module, tmp_path, monkeypatch
):
    root = tmp_path / "root"
    outside = tmp_path / "outside"

    def different_drives(_paths):
        raise ValueError("Paths are on different drives")

    monkeypatch.setattr(loader_module.os.path, "commonpath", different_drives)

    assert not loader_module._is_within_browser_root(str(outside), str(root))
    assert loader_module._browser_value(
        str(outside), str(root), directory=True
    ) == f"{outside}{os.sep}"


def test_trailing_separator_treats_missing_path_as_directory(
    loader_module, tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
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
