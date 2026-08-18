import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";


const EXTENSION_NAME = "ComfyUI.FileHelperSuite.LoadImagePath";
const NODE_NAME = "FHS_LoadImagePath";
const PREVIEW_ROUTE = "/fhs/view-image";
const PREVIEW_DEBOUNCE_MS = 150;
const MIN_PREVIEW_HEIGHT = 120;


function chainCallback(target, property, callback) {
    const original = target[property];
    target[property] = function (...args) {
        const result = original?.apply(this, args);
        callback.apply(this, args);
        return result;
    };
}


function setStyles(element, styles) {
    Object.assign(element.style, styles);
    return element;
}


function createPreviewElements() {
    const container = setStyles(document.createElement("div"), {
        position: "relative",
        display: "grid",
        width: "100%",
        height: "100%",
        minHeight: `${MIN_PREVIEW_HEIGHT}px`,
        overflow: "hidden",
        placeItems: "center",
        borderRadius: "6px",
        background: "rgba(0, 0, 0, 0.22)",
        pointerEvents: "none",
    });
    container.className = "fhs-load-image-path-preview";
    container.style.setProperty(
        "--comfy-widget-min-height",
        `${MIN_PREVIEW_HEIGHT}px`,
    );
    container.style.setProperty("--comfy-widget-height", "100%");

    const image = setStyles(document.createElement("img"), {
        display: "none",
        width: "100%",
        height: "100%",
        minWidth: "0",
        minHeight: "0",
        objectFit: "contain",
    });
    image.alt = "Load Image (Path) preview";
    image.draggable = false;

    const status = setStyles(document.createElement("div"), {
        padding: "12px",
        color: "var(--fg-color, #bbb)",
        font: "12px sans-serif",
        lineHeight: "1.4",
        textAlign: "center",
        overflowWrap: "anywhere",
        userSelect: "none",
    });
    status.textContent = "输入图片路径以显示预览";

    container.append(image, status);
    return { container, image, status };
}


app.registerExtension({
    name: EXTENSION_NAME,

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) {
            return;
        }

        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            const node = this;
            const { container, image, status } = createPreviewElements();
            const previewWidget = node.addDOMWidget(
                "fhs_image_preview",
                "preview",
                container,
                {
                    serialize: false,
                    hideOnZoom: false,
                    getMinHeight: () => MIN_PREVIEW_HEIGHT,
                    getHeight: () => "100%",
                    selectOn: [],
                },
            );
            previewWidget.serialize = false;
            node.resizable = true;

            const minimumSize = node.computeSize();
            node.setSize([
                Math.max(node.size?.[0] ?? 0, minimumSize[0], 320),
                Math.max(node.size?.[1] ?? 0, minimumSize[1], 420),
            ]);

            const imageWidget = node.widgets?.find(
                (widget) => widget.name === "image",
            );
            const widthWidget = node.widgets?.find(
                (widget) => widget.name === "custom_width",
            );
            const heightWidget = node.widgets?.find(
                (widget) => widget.name === "custom_height",
            );

            let debounceTimer;
            let requestController;
            let previewObjectUrl;
            let requestSequence = 0;

            function revokePreviewUrl() {
                if (previewObjectUrl) {
                    URL.revokeObjectURL(previewObjectUrl);
                    previewObjectUrl = undefined;
                }
            }

            function showStatus(message, title = message) {
                image.style.display = "none";
                status.style.display = "block";
                status.textContent = message;
                status.title = title;
                node.graph?.setDirtyCanvas(true, true);
            }

            function showImage(objectUrl) {
                revokePreviewUrl();
                previewObjectUrl = objectUrl;
                image.src = objectUrl;
                image.style.display = "block";
                status.style.display = "none";
                node.graph?.setDirtyCanvas(true, true);
            }

            async function preloadImage(objectUrl) {
                await new Promise((resolve, reject) => {
                    const probe = new Image();
                    probe.onload = resolve;
                    probe.onerror = () => reject(
                        new Error("浏览器无法解码预览图片"),
                    );
                    probe.src = objectUrl;
                });
            }

            async function refreshPreview() {
                const imagePath = String(imageWidget?.value ?? "").trim();
                const sequence = ++requestSequence;

                requestController?.abort();
                requestController = undefined;
                if (!imagePath) {
                    revokePreviewUrl();
                    image.removeAttribute("src");
                    showStatus("输入图片路径以显示预览");
                    return;
                }

                const controller = new AbortController();
                requestController = controller;
                showStatus("正在加载预览…");

                const params = new URLSearchParams({
                    path: imagePath,
                    custom_width: String(Math.trunc(Number(widthWidget?.value) || 0)),
                    custom_height: String(Math.trunc(Number(heightWidget?.value) || 0)),
                });

                let nextObjectUrl;
                try {
                    const response = await api.fetchApi(
                        `${PREVIEW_ROUTE}?${params}`,
                        { signal: controller.signal, cache: "no-store" },
                    );
                    if (!response.ok) {
                        let message = `预览不可用（HTTP ${response.status}）`;
                        try {
                            const detail = await response.json();
                            if (detail?.error) {
                                message = detail.error;
                            }
                        } catch {
                            // Keep the bounded HTTP status message.
                        }
                        throw new Error(message);
                    }

                    nextObjectUrl = URL.createObjectURL(await response.blob());
                    await preloadImage(nextObjectUrl);
                    if (sequence !== requestSequence) {
                        URL.revokeObjectURL(nextObjectUrl);
                        return;
                    }
                    showImage(nextObjectUrl);
                    nextObjectUrl = undefined;
                } catch (error) {
                    if (nextObjectUrl) {
                        URL.revokeObjectURL(nextObjectUrl);
                    }
                    if (error?.name === "AbortError" || sequence !== requestSequence) {
                        return;
                    }
                    revokePreviewUrl();
                    image.removeAttribute("src");
                    const detail = error instanceof Error
                        ? error.message
                        : "无法生成图片预览";
                    showStatus("预览不可用", detail);
                } finally {
                    if (requestController === controller) {
                        requestController = undefined;
                    }
                }
            }

            function schedulePreview(delay = PREVIEW_DEBOUNCE_MS) {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(refreshPreview, delay);
            }

            for (const widget of [imageWidget, widthWidget, heightWidget]) {
                if (widget) {
                    chainCallback(widget, "callback", () => schedulePreview());
                }
            }

            chainCallback(node, "onConfigure", () => schedulePreview(0));
            chainCallback(node, "onRemoved", () => {
                clearTimeout(debounceTimer);
                requestSequence += 1;
                requestController?.abort();
                revokePreviewUrl();
            });

            schedulePreview(0);
        });
    },
});
