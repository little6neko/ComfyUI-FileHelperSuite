from .load_image_path import LoadImagePath


NODE_CLASS_MAPPINGS = {
    "FHS_LoadImagePath": LoadImagePath,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FHS_LoadImagePath": "Load Image (Path)",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
