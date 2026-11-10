import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import {
    PATH_WIDGET_FACTORY,
    createServerPathWidgetFactory,
    replaceServerPathWidget,
} from "./server_path_browser.js";


const EXTENSION_NAME = "ComfyUI.FileHelperSuite.LoadImagePath";
const NODE_NAME = "FHS_LoadImagePath";
const PREVIEW_ROUTE = "/fhs/view-image";
const PREVIEW_DEBOUNCE_MS = 150;


function chainCallback(target, property, callback) {
    const original = target[property];
    target[property] = function (...args) {
        const result = original?.apply(this, args);
        callback.apply(this, args);
        return result;
    };
}


app.registerExtension({
    name: EXTENSION_NAME,

    getCustomWidgets() {
        return {
            [PATH_WIDGET_FACTORY]: createServerPathWidgetFactory({ app, api }),
        };
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) {
            return;
        }

        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            const node = this;
            const generatedImageWidget = node.widgets?.find(
                (widget) => widget.name === "image",
            );
            const imageInputData = (
                nodeData.input?.required?.image
                ?? nodeData.input?.optional?.image
            );
            const {
                widget: imageWidget,
                cleanup: removePathBrowser,
            } = replaceServerPathWidget({
                widget: generatedImageWidget,
                node,
                inputData: imageInputData,
                app,
                api,
                factory: app.widgets?.[PATH_WIDGET_FACTORY],
            });

            node.resizable = true;

            const minimumSize = node.computeSize();
            node.setSize([
                Math.max(node.size?.[0] ?? 0, minimumSize[0], 320),
                Math.max(node.size?.[1] ?? 0, minimumSize[1], 420),
            ]);

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

            function clearPreview() {
                node.imgs = [];
                node.imageIndex = null;
                node.overIndex = null;
                revokePreviewUrl();
                node.graph?.setDirtyCanvas?.(true, true);
            }

            function showImage(objectUrl, image) {
                revokePreviewUrl();
                previewObjectUrl = objectUrl;
                node.imgs = [image];
                node.imageIndex = 0;
                node.overIndex = null;
                node.animatedImages = false;
                node.graph?.setDirtyCanvas?.(true, true);
            }

            async function preloadImage(objectUrl) {
                return await new Promise((resolve, reject) => {
                    const image = new Image();
                    image.onload = () => resolve(image);
                    image.onerror = () => reject(
                        new Error("浏览器无法解码预览图片"),
                    );
                    image.src = objectUrl;
                });
            }

            async function refreshPreview() {
                const imagePath = String(imageWidget?.value ?? "").trim();
                const sequence = ++requestSequence;

                requestController?.abort();
                requestController = undefined;
                if (!imagePath) {
                    clearPreview();
                    return;
                }

                const controller = new AbortController();
                requestController = controller;
                clearPreview();

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
                    const image = await preloadImage(nextObjectUrl);
                    if (sequence !== requestSequence) {
                        URL.revokeObjectURL(nextObjectUrl);
                        return;
                    }
                    showImage(nextObjectUrl, image);
                    nextObjectUrl = undefined;
                } catch (error) {
                    if (nextObjectUrl) {
                        URL.revokeObjectURL(nextObjectUrl);
                    }
                    if (error?.name === "AbortError" || sequence !== requestSequence) {
                        return;
                    }
                    clearPreview();
                    const detail = error instanceof Error
                        ? error.message
                        : "无法生成图片预览";
                    console.warn("[FileHelperSuite] 预览不可用:", detail);
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
                clearPreview();
                removePathBrowser();
            });

            schedulePreview(0);
        });
    },
});
