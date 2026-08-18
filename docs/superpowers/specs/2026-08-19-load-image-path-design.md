# Load Image (Path) Design

Date: 2026-08-19
Status: Approved

## Objective

Create the first node in `ComfyUI-FileHelperSuite`: a standalone ComfyUI node named `Load Image (Path)`. It keeps the arbitrary-path loading and image-dimension controls of Video Helper Suite's `Load Image (Path)`, adds the filename-stem output of QwenEditUtils' `Load Image Return Filename`, removes all VAE support, and adds an image preview whose node width and height can be resized independently.

The implementation must not require ComfyUI-VideoHelperSuite, Comfyui-QwenEditUtils, FFmpeg, or OpenCV at runtime.

## Scope

The feature contains one node, one preview route, one frontend extension, tests, and installation documentation.

The following are intentionally out of scope:

- Uploading files into ComfyUI's input directory.
- Loading video or audio.
- VAE input, latent output, or VAE-related frontend toggles.
- Cropping the preview or stretching it to fill the node.
- Depending on either reference plugin at runtime.

## Node Interface

Internal node identifier: `FHS_LoadImagePath`

Display name: `Load Image (Path)`

Category: `File Helper Suite/Image`

### Inputs

| Name | Type | Rules |
| --- | --- | --- |
| `image` | `STRING` | Local image path with a cross-platform path placeholder. Leading and trailing whitespace and one matching pair of outer quotes are removed. |
| `custom_width` | `INT` | Default `0`, minimum `0`, maximum `8192`, step `8`; `0` disables the width override. |
| `custom_height` | `INT` | Default `0`, minimum `0`, maximum `8192`, step `8`; `0` disables the height override. |

There is no optional `vae` input and no hidden VAE state.

### Outputs

| Name | Type | Meaning |
| --- | --- | --- |
| `image` | `IMAGE` | Float32 BHWC image batch in the `[0, 1]` range. |
| `mask` | `MASK` | Inverted alpha in BHW form; zero masks for opaque images. |
| `filename` | `STRING` | Basename with only the final extension removed, for example `draft.v2.png` becomes `draft.v2`. |

## Components

### Python Image Node

The node owns path normalization, validation, cache invalidation, image decoding, EXIF orientation, frame iteration, resizing, tensor conversion, mask generation, and filename extraction.

Image loading uses Pillow, NumPy, and Torch already supplied by ComfyUI. Animated formats are returned as an image batch. The first decoded frame establishes the source dimensions; every frame is converted to the same target dimensions. Frames with transparency produce inverted alpha masks. If at least one frame has transparency, opaque frames receive target-sized zero masks so the batch remains stackable. If no frame has transparency, the result is a `B x 64 x 64` zero mask, matching established ComfyUI loader behavior.

### Preview Service

The package registers `GET /fhs/view-image`. The route accepts the normalized path and the two custom dimensions, opens only a valid Pillow image, applies EXIF orientation and the same target-aspect calculation as execution, limits the preview's longest edge to 2048 pixels, and re-encodes the first frame as PNG.

The route never returns source-file bytes directly. It executes Pillow work off the async event loop and sends `Cache-Control: no-store`. Missing files, unsupported formats, decompression-bomb protection, and corrupt images produce bounded error responses rather than raw tracebacks.

### Frontend Extension

The frontend extension applies only to `FHS_LoadImagePath` and performs these actions:

- Adds a growable DOM preview widget with a 120-pixel minimum preview height.
- Sets the node as resizable and gives newly created nodes a practical initial size; workflow configuration remains authoritative when a saved node is restored.
- Lets ComfyUI persist the user's node width and height in the workflow.
- Uses `object-fit: contain` so the image keeps its own aspect ratio, can show letterboxing, and is never cropped or stretched by the preview.
- Does not call `setSize(computeSize())` when an image loads, so an image or path update cannot overwrite the user's chosen node height.
- Listens to `image`, `custom_width`, and `custom_height`; changes are debounced and stale requests are cancelled.
- Restores the preview after workflow configuration and shows an inline status for empty, loading, and invalid paths.

The preview occupies available vertical space while the path and size widgets retain fixed heights. Current ComfyUI corner resizing therefore changes preview width and height independently.

## Sizing Semantics

Target dimensions are computed from the source width `W` and height `H`:

1. If both custom values are zero, start with `W x H`.
2. If only width is nonzero, use that width and calculate height as `H * custom_width / W`.
3. If only height is nonzero, use that height and calculate width as `W * custom_height / H`.
4. If both are nonzero, use both values and allow the output image to change aspect ratio.
5. Align each resulting dimension to its nearest positive multiple of 8 using the Video Helper Suite rule `max(8, int(value / 8 + 0.5) * 8)`.

Consequently, with both controls at zero, a source dimension can move by up to four pixels during 8-pixel alignment. With one control at zero, the source aspect ratio is calculated before alignment and can differ slightly afterward. Lanczos resampling is used whenever aligned dimensions differ from the decoded frame.

The preview calculates the same target aspect ratio but scales directly to its capped preview dimensions instead of allocating an intermediate image as large as the requested output.

## Data Flow

1. The user enters an image path or changes a custom dimension.
2. The frontend debounces the change and requests a re-encoded first-frame preview.
3. The preview changes only the growable preview content; it does not modify node dimensions.
4. During workflow execution, `VALIDATE_INPUTS` rejects an empty, missing, non-file, or unreadable path.
5. The node decodes and orients all frames, calculates one target size, resizes frames consistently, and creates image and mask tensors.
6. The node returns the image batch, mask batch, and filename stem.

`IS_CHANGED` derives a stable value from the normalized path, file size, and nanosecond modification time. A path change or on-disk replacement therefore invalidates the cached node without hashing the complete image file.

## Errors and Security

Execution errors identify the actionable cause: empty path, missing path, path is not a file, unsupported image, corrupt image, unsafe image size, or decode failure. The execution path is authoritative even if previewing previously failed.

Preview failures are contained inside the node UI and do not throw into ComfyUI's frontend. The HTTP route validates numeric dimensions, validates that the path resolves to a file, asks Pillow to decode it, and returns only a newly encoded image. This preserves arbitrary image-path functionality without creating a general local-file download endpoint.

Path handling is centralized so validation, execution, cache invalidation, and previewing interpret whitespace, quotes, relative paths, home-directory expansion, native Windows paths, and native POSIX paths consistently. Relative paths resolve against the ComfyUI process working directory.

## Project Layout

```text
ComfyUI-FileHelperSuite/
├── __init__.py
├── nodes/
│   ├── __init__.py
│   └── load_image_path.py
├── server.py
├── web/
│   └── js/
│       └── load_image_path.js
├── tests/
│   ├── conftest.py
│   ├── test_load_image_path.py
│   └── test_preview.py
├── .gitignore
├── pyproject.toml
└── README.md
```

Test images are generated in pytest temporary directories, so the repository does not need binary fixtures. The implementation is original and standalone; README attribution links the two behavior references. Choosing a repository-wide software license is outside this feature and this work does not add a `LICENSE` file.

## Automated Verification

Tests cover:

- RGB loading and BHWC float tensor conversion.
- RGBA loading and inverted-alpha masks.
- Mixed transparent and opaque animation frames.
- EXIF orientation.
- Animated GIF frame batching.
- Zero overrides, width-only proportional resizing, height-only proportional resizing, forced two-dimensional resizing, and 8-pixel alignment.
- Very small images remaining at least 8 pixels in each output dimension.
- Multi-dot filename stems.
- Whitespace, matching outer quotes, relative paths, and home expansion.
- Missing paths, directories, unsupported files, corrupt files, and unsafe image sizes.
- Cache keys changing after file replacement or metadata changes.
- Preview re-encoding, dimension capping, and rejection of non-images.

Verification commands are:

```bash
python -m compileall .
pytest
node --check web/js/load_image_path.js
```

The tests isolate ComfyUI registration modules where necessary, while exercising the real Pillow/NumPy/Torch conversion helpers.

## Manual Acceptance

In a current ComfyUI installation:

1. Install the directory under `custom_nodes` and restart ComfyUI without either reference plugin installed.
2. Add `File Helper Suite/Image > Load Image (Path)`.
3. Confirm the node exposes only `image`, `custom_width`, and `custom_height` inputs and `image`, `mask`, and `filename` outputs.
4. Enter an RGB path and verify that the preview appears before execution.
5. Resize the node from each corner and verify width and height can change independently while the preview uses contain-fit letterboxing.
6. Save and reload the workflow and verify the chosen node dimensions and preview return.
7. Execute with zero, one-sided, and two-sided dimension overrides and compare preview aspect, tensor dimensions, and masks.
8. Load an alpha image and an animated GIF and verify mask and batch behavior.
9. Verify that no VAE input or latent output appears.
10. Verify `draft.v2.png` returns `draft.v2` from `filename`.

## Reference Baselines

- ComfyUI-VideoHelperSuite `LoadImagePath` and resizable preview behavior, inspected at commit [`4ee72c065db22c9d96c2427954dc69e7b908444b`](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite/tree/4ee72c065db22c9d96c2427954dc69e7b908444b).
- Comfyui-QwenEditUtils `LoadImageReturnFilename`, inspected at commit [`cdd4d028c6491d27a40092d7795158668cec9189`](https://github.com/lrzjason/Comfyui-QwenEditUtils/tree/cdd4d028c6491d27a40092d7795158668cec9189).
- Current ComfyUI frontend growable-widget and corner-resize behavior, inspected at commit [`03cce8f37283dfa90330671159244a92381d6676`](https://github.com/Comfy-Org/ComfyUI_frontend/tree/03cce8f37283dfa90330671159244a92381d6676).
