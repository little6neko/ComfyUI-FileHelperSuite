export const SERVER_PATH_ROUTE = "/fhs/list-path";
export const PATH_WIDGET_TYPE = "FHS.PATH";


const DEFAULT_DEBOUNCE_MS = 120;


function setStyles(element, styles) {
    Object.assign(element.style, styles);
    return element;
}


function createDialogElements(documentRef) {
    const dialog = documentRef.createElement("div");
    dialog.className = (
        "litegraph litesearchbox graphdialog rounded fhs-path-dialog"
    );

    const label = documentRef.createElement("span");
    label.className = "name";
    label.textContent = "路径";

    const input = documentRef.createElement("input");
    input.className = "value fhs-path-input";
    input.type = "text";
    input.autofocus = true;

    const confirmButton = documentRef.createElement("button");
    confirmButton.className = "rounded fhs-path-confirm";
    confirmButton.type = "button";
    confirmButton.textContent = "确定";

    const status = setStyles(documentRef.createElement("div"), {
        display: "none",
        padding: "6px 4px",
        opacity: "0.8",
        overflowWrap: "anywhere",
    });
    status.className = "fhs-path-status";

    const entries = documentRef.createElement("div");
    entries.className = "helper fhs-path-entries";

    dialog.append(label, input, confirmButton, status, entries);
    return { dialog, input, confirmButton, status, entries };
}


function positionDialog(dialog, event, app) {
    const canvas = app.canvas?.canvas;
    const rect = canvas?.getBoundingClientRect?.();
    const fallbackX = rect ? rect.left + rect.width / 2 : 80;
    const fallbackY = rect ? rect.top + rect.height / 2 : 80;
    const x = Number.isFinite(event?.clientX) ? event.clientX : fallbackX;
    const y = Number.isFinite(event?.clientY) ? event.clientY : fallbackY;

    dialog.style.left = `${Math.max(8, x - 20)}px`;
    dialog.style.top = `${Math.max(8, y - 20)}px`;
    if ((app.canvas?.ds?.scale ?? 1) > 1) {
        dialog.style.transform = `scale(${app.canvas.ds.scale})`;
        dialog.style.transformOrigin = "top left";
    }
}


function responseError(response, detail) {
    if (detail?.error) {
        return detail.error;
    }
    return `无法读取路径（HTTP ${response.status}）`;
}


function isListing(value) {
    return Boolean(
        value
        && typeof value.directory === "string"
        && Array.isArray(value.entries)
    );
}


function fitPathText(context, value, maxWidth) {
    const text = String(value ?? "");
    if (maxWidth <= 0) {
        return "";
    }
    if (context.measureText(text).width <= maxWidth) {
        return text;
    }

    let low = 0;
    let high = text.length;
    while (low < high) {
        const length = Math.ceil((low + high) / 2);
        const candidate = `…${text.slice(-length)}`;
        if (context.measureText(candidate).width <= maxWidth) {
            low = length;
        } else {
            high = length - 1;
        }
    }
    return low > 0 ? `…${text.slice(-low)}` : "…";
}


export function enhanceServerPathWidget({
    widget,
    node,
    app,
    api,
    documentRef = globalThis.document,
    debounceMs = DEFAULT_DEBOUNCE_MS,
}) {
    if (!widget || !documentRef?.body) {
        return () => {};
    }

    const originalType = widget.type;
    const originalDraw = widget.draw;
    const originalMouse = widget.mouse;
    widget.type = PATH_WIDGET_TYPE;

    const pathDrawHandler = function (context, _node, width, y, height) {
        const liteGraph = globalThis.LiteGraph ?? {};
        const scale = app.canvas?.ds?.scale ?? 1;
        const threshold = app.canvas?.low_quality_zoom_threshold ?? 0.5;
        const showText = liteGraph.vueNodesMode || scale >= threshold;
        const margin = 15;

        context.strokeStyle = liteGraph.WIDGET_OUTLINE_COLOR ?? "#666";
        context.fillStyle = liteGraph.WIDGET_BGCOLOR ?? "#222";
        context.beginPath();
        if (showText && typeof context.roundRect === "function") {
            context.roundRect(
                margin,
                y,
                width - margin * 2,
                height,
                [height * 0.5],
            );
        } else {
            context.rect(margin, y, width - margin * 2, height);
        }
        context.fill();
        if (!showText) {
            return;
        }
        if (!widget.disabled) {
            context.stroke();
        }

        context.save();
        context.beginPath();
        context.rect(margin, y, width - margin * 2, height);
        context.clip();

        const label = widget.label || widget.name || "image";
        context.textAlign = "left";
        context.fillStyle = liteGraph.WIDGET_SECONDARY_TEXT_COLOR ?? "#aaa";
        context.fillText(label, margin * 2, y + height * 0.7);

        const labelWidth = context.measureText(label).width;
        const available = Math.max(0, width - margin * 4 - labelWidth - 10);
        const value = widget.value || widget.options?.placeholder || "";
        context.textAlign = "right";
        context.fillStyle = widget.value
            ? (liteGraph.WIDGET_TEXT_COLOR ?? "#ddd")
            : "#777";
        context.fillText(
            fitPathText(context, value, available),
            width - margin * 2,
            y + height * 0.7,
        );
        context.restore();
    };
    widget.draw = pathDrawHandler;

    function closeActiveDialog() {
        const state = widget.fhsPathBrowserState;
        if (!state) {
            return;
        }
        clearTimeout(state.debounceTimer);
        state.requestSequence += 1;
        state.requestController?.abort();
        state.dialog.remove();
        delete widget.fhsPathBrowserState;
    }

    function commitPath(state, value) {
        widget.value = value;
        widget.callback?.(widget.value, app.canvas, node);
        node.graph?.setDirtyCanvas?.(true, true);
        state.close();
    }

    function openDialog(event) {
        const active = widget.fhsPathBrowserState;
        if (active?.dialog?.isConnected) {
            active.input.focus();
            return active;
        }
        closeActiveDialog();

        const elements = createDialogElements(documentRef);
        const state = {
            ...elements,
            debounceTimer: undefined,
            requestController: undefined,
            requestSequence: 0,
            close: closeActiveDialog,
        };
        widget.fhsPathBrowserState = state;
        state.input.value = String(widget.value ?? "");

        function showStatus(message, isError = false) {
            state.entries.replaceChildren();
            state.status.style.display = "block";
            state.status.textContent = message;
            state.status.title = message;
            state.status.style.color = isError ? "#f88" : "";
        }

        function createEntry(label, path, kind) {
            const entry = documentRef.createElement("div");
            entry.className = "litegraph lite-search-item fhs-path-entry";
            if (kind === "directory") {
                entry.className += " is-dir";
            }
            entry.textContent = label;
            entry.title = path;
            entry.fhsPathEntry = { path, kind };
            entry.addEventListener("click", () => {
                if (kind === "directory") {
                    state.input.value = path;
                    scheduleListing(0);
                    return;
                }
                commitPath(state, path);
            });
            state.entries.append(entry);
        }

        function renderListing(listing) {
            state.entries.replaceChildren();
            state.status.style.display = "none";
            state.status.textContent = "";
            state.status.title = "";
            state.status.style.color = "";

            if (listing.parent) {
                createEntry("../", listing.parent, "directory");
            }

            const prefix = String(listing.remainder ?? "").toLocaleLowerCase();
            const visibleEntries = listing.entries.filter((entry) => (
                entry
                && typeof entry.name === "string"
                && typeof entry.path === "string"
                && ["directory", "file"].includes(entry.kind)
                && entry.name.toLocaleLowerCase().startsWith(prefix)
            ));
            for (const entry of visibleEntries) {
                const label = entry.kind === "directory"
                    ? `${entry.name}/`
                    : entry.name;
                createEntry(label, entry.path, entry.kind);
            }

            if (!listing.parent && visibleEntries.length === 0) {
                showStatus("没有匹配的图片或目录");
            } else if (listing.parent && visibleEntries.length === 0) {
                state.status.style.display = "block";
                state.status.textContent = "没有匹配的图片或目录";
            }
        }

        async function refreshListing() {
            const sequence = ++state.requestSequence;
            state.requestController?.abort();
            const controller = new AbortController();
            state.requestController = controller;
            showStatus("正在读取路径…");

            const params = new URLSearchParams({ path: state.input.value });
            try {
                const response = await api.fetchApi(
                    `${SERVER_PATH_ROUTE}?${params}`,
                    { signal: controller.signal, cache: "no-store" },
                );
                let detail;
                try {
                    detail = await response.json();
                } catch {
                    detail = undefined;
                }
                if (!response.ok) {
                    throw new Error(responseError(response, detail));
                }
                if (!isListing(detail)) {
                    throw new Error("路径服务返回了无效数据");
                }
                if (sequence === state.requestSequence) {
                    renderListing(detail);
                }
            } catch (error) {
                if (
                    error?.name === "AbortError"
                    || sequence !== state.requestSequence
                ) {
                    return;
                }
                const message = error instanceof Error
                    ? error.message
                    : "无法读取路径";
                showStatus(message, true);
            } finally {
                if (state.requestController === controller) {
                    state.requestController = undefined;
                }
            }
        }

        function scheduleListing(delay = debounceMs) {
            clearTimeout(state.debounceTimer);
            state.debounceTimer = setTimeout(refreshListing, delay);
        }

        state.input.addEventListener("input", () => scheduleListing());
        state.input.addEventListener("keydown", (keyEvent) => {
            if (keyEvent.key === "Escape") {
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                state.close();
            } else if (keyEvent.key === "Enter") {
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                commitPath(state, state.input.value);
            }
        });
        state.confirmButton.addEventListener("click", () => {
            commitPath(state, state.input.value);
        });

        documentRef.body.append(state.dialog);
        positionDialog(state.dialog, event, app);
        state.input.focus();
        scheduleListing(0);
        return state;
    }

    const pathMouseHandler = function (event) {
        if (widget.disabled) {
            return originalMouse?.apply(this, arguments);
        }
        app.canvas.node_widget = null;
        openDialog(event);
        return true;
    };
    widget.mouse = pathMouseHandler;

    return () => {
        closeActiveDialog();
        if (widget.draw === pathDrawHandler) {
            widget.draw = originalDraw;
        }
        if (widget.mouse === pathMouseHandler) {
            widget.mouse = originalMouse;
        }
        if (widget.type === PATH_WIDGET_TYPE) {
            widget.type = originalType;
        }
    };
}
