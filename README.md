# ComfyUI-FileHelperSuite

面向本地文件工作流的轻量 ComfyUI 节点集合。目前包含第一个节点：`Load Image (Path)`。

## 功能

- 从任意本地路径加载静态图片或动图。
- 点击 `image` 路径控件浏览 ComfyUI 服务器目录并选择图片。
- 输出 `IMAGE`、`MASK` 和不含扩展名的 `filename`。
- 使用 `custom_width`、`custom_height` 调整输出尺寸。
- 图片路径或尺寸变化后即时刷新预览。
- 节点框的宽度和高度可独立拖动；预览保持图片自身比例，不裁切、不拉伸。
- 不包含 VAE 输入，不输出 latent。
- 不依赖 ComfyUI-VideoHelperSuite、Comfyui-QwenEditUtils、FFmpeg 或 OpenCV。

## 安装

将整个 `ComfyUI-FileHelperSuite` 目录放入：

```text
ComfyUI/custom_nodes/ComfyUI-FileHelperSuite
```

重启 ComfyUI。节点位于：

```text
File Helper Suite / Image / Load Image (Path)
```

插件使用 ComfyUI 已提供的 Pillow、NumPy、Torch 和 aiohttp，无需单独安装运行时依赖。

## 节点接口

### 输入

| 输入 | 说明 |
| --- | --- |
| `image` | 本地图片的绝对路径或相对路径；相对路径从 ComfyUI 进程的工作目录解析。支持路径两侧空格、成对单引号或双引号。 |
| `custom_width` | 默认 `0`，范围 `0–8192`，步长 `8`。`0` 表示不覆盖宽度。 |
| `custom_height` | 默认 `0`，范围 `0–8192`，步长 `8`。`0` 表示不覆盖高度。 |

### 输出

| 输出 | 类型 | 说明 |
| --- | --- | --- |
| `image` | `IMAGE` | BHWC 图片批次；动图的每一帧作为一个批次元素。 |
| `mask` | `MASK` | Alpha 的反向遮罩；无 Alpha 时为零遮罩。 |
| `filename` | `STRING` | 去掉最后一个扩展名的文件名。例如 `draft.v2.png` 返回 `draft.v2`。 |

## 服务器路径选择

点击节点中的 `image` 路径控件会打开 File Helper Suite 路径窗口：

- 路径为空时从 ComfyUI 进程的工作目录开始。
- 可以进入子目录、返回上级目录并选择 Pillow 支持的图片。
- 选择图片后会写入服务器上的绝对路径并立即刷新预览。
- 仍可手动输入或粘贴绝对路径、相对路径、带引号路径。
- `Enter` 或“确定”提交手动路径，`Esc` 取消本次选择。

这里浏览的是运行 ComfyUI 的服务器文件系统。如果浏览器和 ComfyUI
不在同一台机器上，它不会浏览浏览器所在电脑的文件。

## 尺寸规则

- 两项均为 `0`：从原始宽高开始。
- 只设置一项：按照原图比例计算另一项。
- 两项都设置：强制使用指定比例。
- 最终宽高分别对齐到最近的正 8 倍数，因此即使两项均为 `0`，边长也可能变化最多 4 像素。
- 需要缩放时使用 Lanczos。

## 自由调整节点预览

选中节点后拖动任意角落即可独立改变节点宽度和高度。预览区域占用输入控件以外的可用空间，并使用 contain 模式显示：图片保持自身比例，空余部分留边。

节点尺寸保存在工作流中。更改路径、输出尺寸或重新加载预览不会自动重置用户已经调整好的节点尺寸。

## 路径与安全

执行节点前会检查路径是否存在、是否为普通文件以及 Pillow 能否识别图片。路径浏览接口只返回当前 ComfyUI 系统账户可访问的目录和图片路径信息。预览接口不会直接发送任意本地文件的原始字节，而是解码首帧、限制最长边并重新编码为 PNG。

浏览器预览失败不会影响 ComfyUI 前端；执行节点时仍会给出具体的路径或解码错误。

## 开发验证

在具备 ComfyUI 核心 Python 依赖的环境中运行：

```bash
python3 -m pytest
python3 -m compileall -q __init__.py nodes server.py tests
node --check web/js/load_image_path.js
node --check web/js/server_path_browser.js
node --test tests/frontend_path_browser.test.mjs
```

## 行为参考

本插件为独立实现，行为设计参考：

- [ComfyUI-VideoHelperSuite `Load Image (Path)`](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite/tree/4ee72c065db22c9d96c2427954dc69e7b908444b)
- [Comfyui-QwenEditUtils `Load Image Return Filename`](https://github.com/lrzjason/Comfyui-QwenEditUtils/tree/cdd4d028c6491d27a40092d7795158668cec9189)
