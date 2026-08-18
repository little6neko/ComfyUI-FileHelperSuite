if __package__:
    from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
    from . import server as _server  # Register routes during custom-node import.
else:
    # Pytest imports a repository-root __init__.py as a top-level module when
    # the directory name contains a hyphen. Keep that tooling path importable;
    # ComfyUI always loads this file with a real package name and takes the
    # branch above.
    from nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS


WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
