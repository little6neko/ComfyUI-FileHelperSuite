# Server Path Browser Design

Date: 2026-08-19
Status: Approved

## Objective

Add a server-side image path browser to `Load Image (Path)`. Clicking the
`image` path widget opens a searchable directory browser for the machine that
runs ComfyUI. Selecting an image writes its normalized absolute path into the
existing input and refreshes the existing preview.

The feature must remain standalone. It must not require
ComfyUI-VideoHelperSuite or copy its names into the user interface, route names,
widget types, or implementation identifiers.

## Scope

The change adds one directory-listing route and enhances the existing `image`
widget. It preserves all existing node behavior:

- Internal node identifier `FHS_LoadImagePath`.
- Display name `Load Image (Path)`.
- `image`, `custom_width`, and `custom_height` inputs.
- `IMAGE`, `MASK`, and `filename` outputs.
- Static and animated image loading, resizing, masking, cache invalidation, and
  preview generation.
- Independently resizable node width and height with contain-fit previewing.
- Existing workflow serialization and manual path entry.
- No VAE input or latent output.

Uploading files, browsing the client computer when ComfyUI runs on another
machine, and adding a browser-native file input are outside this change.

## User Interaction

The existing `image` input remains a `STRING`. Its frontend widget is enhanced
in place so saved workflows and prompt API payloads retain the same schema.

Clicking the path widget opens a File Helper Suite path dialog with a text
input, confirmation button, status area, and directory entries:

1. An empty value starts in the ComfyUI process working directory.
2. An existing image path opens its containing directory and filters the list
   using the filename portion.
3. A directory path opens that directory.
4. A partially typed path opens its existing parent directory and filters by
   the remaining filename prefix.
5. The list shows an upper-directory entry where one exists, followed by child
   directories and Pillow-supported image files.
6. Selecting a directory continues browsing without committing a node value.
7. Selecting an image commits its normalized absolute path, marks the graph as
   changed, closes the dialog, and invokes the existing preview callback.
8. The user can type or paste a path. `Enter` or the confirmation button commits
   it, while `Escape` closes the dialog without changing the node.

Directories are listed before files, and each group is sorted by
case-insensitive name. Directory navigation and committed paths work with the
native path rules of the ComfyUI host operating system. Path joining is done by
the backend rather than by browser string concatenation.

No visible label, widget type, endpoint, CSS class, extension name, or code
identifier introduced by this feature contains VHS branding. New identifiers
use `FHS` or `File Helper Suite` naming.

## Backend Path Service

The package registers `GET /fhs/list-path`. It accepts a single `path` query
parameter containing the current dialog input. An empty parameter is valid and
means the ComfyUI process working directory.

Path resolution applies the same outer whitespace, matching quote, and home
expansion rules as image execution. The service distinguishes an existing
directory, an existing file, and a partial path. It resolves the directory on
the server and returns structured JSON:

```json
{
  "directory": "/absolute/current/directory",
  "parent": "/absolute/parent/directory",
  "remainder": "typed-prefix",
  "entries": [
    {
      "name": "images",
      "path": "/absolute/current/directory/images",
      "kind": "directory"
    },
    {
      "name": "example.png",
      "path": "/absolute/current/directory/example.png",
      "kind": "file"
    }
  ]
}
```

At a filesystem root, `parent` is `null`. The backend returns directories
regardless of extension. Regular files are included only when their final
extension is one Pillow registers as an image format. The client cannot supply
an alternative extension allowlist.

Directory scanning runs through `asyncio.to_thread` so a slow filesystem does
not block the ComfyUI event loop. Broken entries and entries that disappear
during scanning are skipped. Symlinks follow the host operating system's normal
resolution behavior and remain bounded by that process account's permissions.

Responses use `Cache-Control: no-store`. The route returns path metadata only;
it never returns source-file bytes. Image display continues through the
existing `/fhs/view-image` route, which decodes and re-encodes the first frame.

## Frontend Components and Data Flow

The frontend extension enhances the existing image widget rather than
replacing its serialized input:

- A File Helper Suite path renderer displays long paths compactly inside the
  node.
- A click handler creates one path dialog per node widget.
- A debounced request controller calls `/fhs/list-path` as the user types or
  navigates.
- Every request has a sequence number and abort controller. Closing the dialog
  or starting a newer request prevents stale results from updating the list.
- Directory entries replace the dialog input with the server-provided native
  path and request the next listing.
- File entries set the existing widget value and invoke its existing callback,
  so preview refresh behavior stays centralized.
- Manual confirmation uses the exact entered value, preserving the current
  ability to use relative paths and quoted paths.
- Node removal closes the dialog and releases listeners and pending requests.

The path dialog does not call `setSize`, recompute the node dimensions, or
modify the preview DOM widget. Existing width and height persistence therefore
remains authoritative.

## Errors and Security Boundary

The path browser intentionally exposes only filesystem locations readable by
the operating-system account running ComfyUI, matching the node's existing
arbitrary local-path purpose.

Expected failures are bounded and actionable:

- A nonexistent parent directory returns `404`.
- A path that cannot be listed because of permissions returns `403`.
- A malformed path or unsupported request returns `400`.
- An unexpected scan failure is logged server-side and returns a generic `500`
  message without a traceback.

The frontend renders these errors inside the open dialog and leaves the node's
current path unchanged. A failed listing does not disable manual path entry,
previewing, workflow loading, or execution.

This endpoint adds directory-name visibility and should be treated with the
same trust boundary as ComfyUI itself. It does not add authentication or expose
files beyond the permissions of the ComfyUI process.

## Automated Verification

Backend helper and route tests cover:

- Empty input resolving to the process working directory.
- Existing directory, existing image, relative path, quoted path, and partial
  filename resolution.
- Parent navigation, including a filesystem root with no parent.
- Directory-first sorting and case-insensitive ordering.
- Pillow image extension filtering and exclusion of non-image files.
- Disappearing or broken directory entries.
- Missing directories, permission errors, malformed paths, and bounded HTTP
  responses.
- Registration of both `/fhs/list-path` and `/fhs/view-image`.

Frontend tests cover:

- The image input retaining its `STRING` backend contract.
- Clicking the path widget opening only one dialog.
- Empty, loading, populated, and error states.
- Entering directories, returning to the parent, and selecting an image.
- Selecting an image updating the existing widget and invoking preview refresh.
- `Enter`, confirmation, and `Escape` behavior.
- Debouncing, stale-response rejection, request cancellation, and cleanup when
  the dialog or node is removed.
- Absence of VHS branding from the new widget, route, and UI text.

Existing loader, preview, registration, resizing, and filename tests remain in
place. Verification commands remain:

```bash
python -m pytest
python -m compileall -q __init__.py nodes server.py tests
node --check web/js/load_image_path.js
```

## Manual Acceptance

In a current ComfyUI installation:

1. Add `File Helper Suite/Image > Load Image (Path)`.
2. Click the `image` path widget and confirm that the server path dialog opens.
3. With an empty value, confirm browsing begins at the ComfyUI working
   directory.
4. Enter and leave nested directories, use the parent entry, and confirm only
   folders and supported images appear.
5. Select an image and confirm its absolute path is written and the preview
   refreshes immediately.
6. Type a relative or quoted path manually and confirm it can still be
   submitted.
7. Confirm an inaccessible or nonexistent path shows an inline error without
   changing the existing node value.
8. Resize the node in both dimensions and confirm the path dialog interaction
   does not reset the chosen size.
9. Save and reload the workflow and confirm the selected path, node size,
   preview, dimensions, and outputs are restored.
10. Confirm the new UI contains File Helper Suite naming only and no VHS label.

## Reference

The interaction behavior was studied from ComfyUI-VideoHelperSuite's server
path widget and directory listing route at commit
`4ee72c065db22c9d96c2427954dc69e7b908444b`. This implementation remains
independent and uses its own route contract, cross-platform server path
resolution, identifiers, error handling, and tests.
