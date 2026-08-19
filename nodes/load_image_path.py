from __future__ import annotations

import hashlib
import io
import math
import os
import stat
import warnings
from collections.abc import Iterator

import numpy as np
import torch
from PIL import Image, ImageOps, UnidentifiedImageError


MAX_CUSTOM_DIMENSION = 8192
MAX_OUTPUT_EDGE = 65535
PREVIEW_MAX_EDGE = 2048
ALIGNMENT = 8

try:
    LANCZOS = Image.Resampling.LANCZOS
except AttributeError:  # Pillow < 9.1
    LANCZOS = Image.LANCZOS


IMAGE_FILE_EXTENSIONS = frozenset(
    extension.casefold() for extension in Image.registered_extensions()
)


class ImagePathError(ValueError):
    """Raised when an image path cannot be used."""


class ImageDecodeError(ValueError):
    """Raised when Pillow cannot decode an image."""


class UnsafeImageError(ValueError):
    """Raised when source or target dimensions exceed Pillow's safety limit."""


def strip_image_path(value: str) -> str:
    """Remove supported user-entry decoration without resolving the path."""
    if not isinstance(value, str):
        raise ImagePathError("Image path must be a string.")

    path = value.strip()
    if len(path) >= 2 and path[0] == path[-1] and path[0] in {"'", '"'}:
        path = path[1:-1]
    return path


def normalize_image_path(value: str) -> str:
    """Normalize user-entered paths consistently across node and preview code."""
    path = strip_image_path(value)
    if not path:
        raise ImagePathError("Image path is empty.")

    try:
        return os.path.abspath(os.path.expanduser(path))
    except (OSError, ValueError) as exc:
        raise ImagePathError("Image path is invalid.") from exc


def _has_trailing_separator(path: str) -> bool:
    separators = [os.sep]
    if os.altsep:
        separators.append(os.altsep)
    return path.endswith(tuple(separators))


def resolve_browser_location(value: str) -> tuple[str, str]:
    """Resolve a directory and filename prefix from path-browser input."""
    path = strip_image_path(value)
    if not path:
        try:
            return os.path.abspath(os.curdir), ""
        except OSError as exc:
            raise ImagePathError("Current working directory is unavailable.") from exc

    try:
        candidate = os.path.abspath(os.path.expanduser(path))
    except (OSError, ValueError) as exc:
        raise ImagePathError("Image path is invalid.") from exc

    try:
        candidate_stat = os.stat(candidate)
    except FileNotFoundError:
        if _has_trailing_separator(path):
            return candidate, ""
        return os.path.dirname(candidate), os.path.basename(candidate)
    except NotADirectoryError:
        return os.path.dirname(candidate), os.path.basename(candidate)
    except PermissionError:
        raise
    except (OSError, ValueError) as exc:
        raise ImagePathError("Image path is invalid.") from exc

    if stat.S_ISDIR(candidate_stat.st_mode):
        return candidate, ""
    return os.path.dirname(candidate), os.path.basename(candidate)


def _browser_parent(directory: str) -> str | None:
    parent = os.path.dirname(os.path.normpath(directory))
    if os.path.normcase(parent) == os.path.normcase(os.path.normpath(directory)):
        return None
    return parent


def list_image_paths(value: str) -> dict[str, object]:
    """List browsable directories and Pillow-supported images for a path."""
    directory, remainder = resolve_browser_location(value)
    entries: list[dict[str, str]] = []

    try:
        with os.scandir(directory) as directory_entries:
            for entry in directory_entries:
                try:
                    if entry.is_dir():
                        kind = "directory"
                    elif entry.is_file() and (
                        os.path.splitext(entry.name)[1].casefold()
                        in IMAGE_FILE_EXTENSIONS
                    ):
                        kind = "file"
                    else:
                        continue
                    entries.append(
                        {
                            "name": entry.name,
                            "path": os.path.abspath(entry.path),
                            "kind": kind,
                        }
                    )
                except OSError:
                    # Broken links and entries removed during iteration are skipped.
                    continue
    except FileNotFoundError as exc:
        raise FileNotFoundError(
            f"Directory does not exist: {directory}"
        ) from exc
    except NotADirectoryError as exc:
        raise FileNotFoundError(
            f"Directory does not exist: {directory}"
        ) from exc
    except PermissionError as exc:
        raise PermissionError(
            f"Directory is not accessible: {directory}"
        ) from exc

    entries.sort(
        key=lambda entry: (
            entry["kind"] != "directory",
            entry["name"].casefold(),
            entry["name"],
        )
    )
    return {
        "directory": directory,
        "parent": _browser_parent(directory),
        "remainder": remainder,
        "entries": entries,
    }


def require_image_file(value: str) -> str:
    path = normalize_image_path(value)
    try:
        exists = os.path.exists(path)
        is_file = os.path.isfile(path)
    except (OSError, ValueError) as exc:
        raise ImagePathError("Image path is invalid.") from exc

    if not exists:
        raise ImagePathError(f"Image file does not exist: {path}")
    if not is_file:
        raise ImagePathError(f"Image path is not a file: {path}")
    if not os.access(path, os.R_OK):
        raise ImagePathError(f"Image file is not readable: {path}")
    return path


def _dimension(value: int, name: str) -> int:
    if isinstance(value, bool):
        value = int(value)
    try:
        result = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{name} must be an integer.") from exc
    if result < 0 or result > MAX_CUSTOM_DIMENSION:
        raise ValueError(
            f"{name} must be between 0 and {MAX_CUSTOM_DIMENSION}."
        )
    return result


def _align_dimension(value: float) -> int:
    if not math.isfinite(value) or value <= 0:
        raise UnsafeImageError("Calculated image dimensions are invalid.")
    return max(ALIGNMENT, int(value / ALIGNMENT + 0.5) * ALIGNMENT)


def calculate_target_size(
    source_size: tuple[int, int], custom_width: int = 0, custom_height: int = 0
) -> tuple[int, int]:
    """Calculate VHS-compatible target dimensions with 8-pixel alignment."""
    source_width, source_height = source_size
    if source_width <= 0 or source_height <= 0:
        raise UnsafeImageError("Source image dimensions are invalid.")

    width_override = _dimension(custom_width, "custom_width")
    height_override = _dimension(custom_height, "custom_height")

    if width_override == 0 and height_override == 0:
        target_width = float(source_width)
        target_height = float(source_height)
    elif height_override == 0:
        target_width = float(width_override)
        target_height = source_height * target_width / source_width
    elif width_override == 0:
        target_height = float(height_override)
        target_width = source_width * target_height / source_height
    else:
        target_width = float(width_override)
        target_height = float(height_override)

    width = _align_dimension(target_width)
    height = _align_dimension(target_height)
    pixel_limit = int(Image.MAX_IMAGE_PIXELS or 89_478_485)
    if width > MAX_OUTPUT_EDGE or height > MAX_OUTPUT_EDGE:
        raise UnsafeImageError(
            f"Target image edge exceeds the {MAX_OUTPUT_EDGE}-pixel safety limit: "
            f"{width}x{height}."
        )
    if width * height > pixel_limit:
        raise UnsafeImageError(
            f"Target image exceeds the {pixel_limit}-pixel safety limit: "
            f"{width}x{height}."
        )
    return width, height


def _frame_has_alpha(frame: Image.Image) -> bool:
    return "A" in frame.getbands() or (
        frame.mode == "P" and "transparency" in frame.info
    )


def _safe_frames(path: str) -> Iterator[tuple[Image.Image, bool]]:
    """Yield detached, EXIF-oriented frames while translating Pillow errors."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as source:
                frame_count = int(getattr(source, "n_frames", 1))
                for index in range(frame_count):
                    source.seek(index)
                    has_alpha = _frame_has_alpha(source)
                    frame = ImageOps.exif_transpose(source.copy())
                    frame.load()
                    yield frame, has_alpha
    except Image.DecompressionBombError as exc:
        raise UnsafeImageError(f"Image exceeds Pillow's safety limit: {path}") from exc
    except Image.DecompressionBombWarning as exc:
        raise UnsafeImageError(f"Image exceeds Pillow's safety limit: {path}") from exc
    except UnidentifiedImageError as exc:
        raise ImageDecodeError(f"Unsupported or invalid image file: {path}") from exc
    except (EOFError, OSError, SyntaxError, ValueError) as exc:
        raise ImageDecodeError(f"Unable to decode image: {path}") from exc


def validate_image_file(value: str) -> str:
    """Return the normalized path after validating that Pillow can decode it."""
    path = require_image_file(value)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                image.verify()
    except Image.DecompressionBombError as exc:
        raise UnsafeImageError(f"Image exceeds Pillow's safety limit: {path}") from exc
    except Image.DecompressionBombWarning as exc:
        raise UnsafeImageError(f"Image exceeds Pillow's safety limit: {path}") from exc
    except UnidentifiedImageError as exc:
        raise ImageDecodeError(f"Unsupported or invalid image file: {path}") from exc
    except (EOFError, OSError, SyntaxError, ValueError) as exc:
        raise ImageDecodeError(f"Unable to decode image: {path}") from exc
    return path


def load_image_file(
    value: str, custom_width: int = 0, custom_height: int = 0
) -> tuple[torch.Tensor, torch.Tensor, str]:
    """Load an arbitrary local image path into ComfyUI image and mask tensors."""
    path = require_image_file(value)
    images: list[torch.Tensor] = []
    masks: list[torch.Tensor | None] = []
    target_size: tuple[int, int] | None = None

    for frame, has_alpha in _safe_frames(path):
        if target_size is None:
            target_size = calculate_target_size(
                frame.size, custom_width, custom_height
            )

        converted = frame.convert("RGBA" if has_alpha else "RGB")
        if converted.size != target_size:
            converted = converted.resize(target_size, LANCZOS)

        if has_alpha:
            rgba = np.asarray(converted, dtype=np.float32) / 255.0
            images.append(torch.from_numpy(rgba[..., :3].copy()))
            masks.append(torch.from_numpy((1.0 - rgba[..., 3]).copy()))
        else:
            rgb = np.asarray(converted, dtype=np.float32) / 255.0
            images.append(torch.from_numpy(rgb.copy()))
            masks.append(None)

    if not images or target_size is None:
        raise ImageDecodeError(f"Image contains no decodable frames: {path}")

    image_batch = torch.stack(images, dim=0).to(dtype=torch.float32)
    if any(mask is not None for mask in masks):
        width, height = target_size
        mask_batch = torch.stack(
            [
                mask
                if mask is not None
                else torch.zeros((height, width), dtype=torch.float32)
                for mask in masks
            ],
            dim=0,
        ).to(dtype=torch.float32)
    else:
        mask_batch = torch.zeros(
            (len(images), 64, 64), dtype=torch.float32, device="cpu"
        )

    filename = os.path.splitext(os.path.basename(path))[0]
    return image_batch, mask_batch, filename


def render_preview_png(
    value: str,
    custom_width: int = 0,
    custom_height: int = 0,
    max_edge: int = PREVIEW_MAX_EDGE,
) -> bytes:
    """Decode and re-encode the first frame for the browser preview."""
    path = require_image_file(value)
    if not isinstance(max_edge, int) or max_edge <= 0:
        raise ValueError("max_edge must be a positive integer.")

    frames = _safe_frames(path)
    try:
        try:
            frame, has_alpha = next(frames)
        except StopIteration as exc:
            raise ImageDecodeError(
                f"Image contains no decodable frames: {path}"
            ) from exc
    finally:
        close = getattr(frames, "close", None)
        if close is not None:
            close()

    target_width, target_height = calculate_target_size(
        frame.size, custom_width, custom_height
    )
    scale = min(1.0, max_edge / max(target_width, target_height))
    preview_size = (
        max(1, int(target_width * scale + 0.5)),
        max(1, int(target_height * scale + 0.5)),
    )

    converted = frame.convert("RGBA" if has_alpha else "RGB")
    if converted.size != preview_size:
        converted = converted.resize(preview_size, LANCZOS)

    output = io.BytesIO()
    converted.save(output, format="PNG", compress_level=3)
    return output.getvalue()


def change_token(
    value: str, custom_width: int = 0, custom_height: int = 0
) -> str:
    """Create a lightweight cache token from path and filesystem metadata."""
    try:
        path = normalize_image_path(value)
    except ImagePathError:
        path = str(value)

    try:
        stat = os.stat(path)
        metadata = f"{stat.st_size}:{stat.st_mtime_ns}"
    except (OSError, ValueError):
        metadata = "missing"

    payload = (
        f"{path}\0{metadata}\0{_dimension(custom_width, 'custom_width')}"
        f"\0{_dimension(custom_height, 'custom_height')}"
    )
    return hashlib.sha256(payload.encode("utf-8", "surrogatepass")).hexdigest()


class LoadImagePath:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "STRING",
                    {
                        "default": "",
                        "placeholder": "X://path/to/image.png",
                        "tooltip": "Absolute or relative path to a local image.",
                    },
                ),
                "custom_width": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": MAX_CUSTOM_DIMENSION,
                        "step": ALIGNMENT,
                        "tooltip": "0 keeps the source width or derives it from height.",
                    },
                ),
                "custom_height": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": MAX_CUSTOM_DIMENSION,
                        "step": ALIGNMENT,
                        "tooltip": "0 keeps the source height or derives it from width.",
                    },
                ),
            }
        }

    CATEGORY = "File Helper Suite/Image"
    DESCRIPTION = (
        "Loads an image from an arbitrary local path, with optional dimensions "
        "and a filename-stem output."
    )
    SEARCH_ALIASES = ["load image path", "open image path", "image filename"]

    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "filename")
    FUNCTION = "load_image"

    def load_image(self, image: str, custom_width: int = 0, custom_height: int = 0):
        return load_image_file(image, custom_width, custom_height)

    @classmethod
    def IS_CHANGED(
        cls, image: str, custom_width: int = 0, custom_height: int = 0
    ) -> str:
        return change_token(image, custom_width, custom_height)

    @classmethod
    def VALIDATE_INPUTS(
        cls, image: str, custom_width: int = 0, custom_height: int = 0
    ):
        try:
            _dimension(custom_width, "custom_width")
            _dimension(custom_height, "custom_height")
            validate_image_file(image)
        except (ImagePathError, ImageDecodeError, UnsafeImageError, ValueError) as exc:
            return str(exc)
        return True
