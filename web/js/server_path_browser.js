export const SERVER_PATH_ROUTE = "/fhs/list-path";
export const PATH_WIDGET_TYPE = "FHS.PATH";
export const PATH_WIDGET_FACTORY = "FHSPATH";


const DEFAULT_DEBOUNCE_MS = 120;


function createDialogElements(documentRef) {
    const dialog = documentRef.createElement("div");
    dialog.className = "litegraph litesearchbox graphdialog rounded";

    const label = documentRef.createElement("span");
    label.className = "name";
    label.textContent = "Path";

    const input = documentRef.createElement("input");
    input.className = "value";
    input.type = "text";
    input.autofocus = true;

    const confirmButton = documentRef.createElement("button");
    confirmButton.className = "rounded";
    confirmButton.textContent = "OK";

    const helper = documentRef.createElement("div");
    helper.className = "helper";

    dialog.append(label, input, confirmButton, helper);
    return { dialog, label, input, confirmButton, helper };
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
        && typeof value.value === "string"
        && (value.parent === null || typeof value.parent === "string")
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


function drawPathWidget(context, _node, width, y, height, app) {
    const widget = this;
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
}


function closeActiveDialog(widget) {
    const state = widget?.fhsPathBrowserState;
    if (!state) {
        return;
    }
    clearTimeout(state.debounceTimer);
    state.requestSequence += 1;
    state.requestController?.abort();
    state.dialog.remove();
    delete widget.fhsPathBrowserState;
}


function commitPath(widget, state, value, app, node) {
    widget.value = value;
    widget.callback?.(widget.value, app.canvas, node);
    node?.graph?.setDirtyCanvas?.(true, true);
    state.close();
}


function createHelperMessage(documentRef, message, isError = false) {
    const element = documentRef.createElement("div");
    element.className = "litegraph lite-search-item fhs-path-message";
    element.textContent = message;
    element.title = message;
    if (isError) {
        element.style.color = "#f88";
    }
    return element;
}


function openPathDialog({
    widget,
    node,
    event,
    app,
    api,
    documentRef,
    debounceMs,
}) {
    if (!documentRef?.body) {
        return undefined;
    }

    const active = widget.fhsPathBrowserState;
    if (active?.dialog?.isConnected) {
        active.input.focus();
        return active;
    }
    closeActiveDialog(widget);

    const elements = createDialogElements(documentRef);
    const state = {
        ...elements,
        debounceTimer: undefined,
        requestController: undefined,
        requestSequence: 0,
        message: undefined,
        close: () => closeActiveDialog(widget),
    };
    widget.fhsPathBrowserState = state;
    state.input.value = String(widget.value ?? "");

    function showMessage(message, isError = false) {
        state.helper.replaceChildren();
        state.message = createHelperMessage(documentRef, message, isError);
        state.helper.append(state.message);
    }

    function appendMessage(message, isError = false) {
        state.message = createHelperMessage(documentRef, message, isError);
        state.helper.append(state.message);
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
            commitPath(widget, state, path, app, node);
        });
        state.helper.append(entry);
    }

    function renderListing(listing) {
        state.helper.replaceChildren();
        state.message = undefined;
        state.input.value = listing.value;

        if (listing.parent !== null) {
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

        if (visibleEntries.length === 0) {
            appendMessage("没有匹配的图片或目录");
        }
    }

    async function refreshListing() {
        const sequence = ++state.requestSequence;
        state.requestController?.abort();
        const controller = new AbortController();
        state.requestController = controller;
        showMessage("正在读取路径…");

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
            showMessage(message, true);
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
            commitPath(widget, state, state.input.value, app, node);
        }
    });
    state.confirmButton.addEventListener("click", () => {
        commitPath(widget, state, state.input.value, app, node);
    });

    documentRef.body.append(state.dialog);
    positionDialog(state.dialog, event, app);
    state.input.focus();
    scheduleListing(0);
    return state;
}


export function createServerPathWidget({
    node,
    inputName,
    inputData,
    app,
    api,
    documentRef = globalThis.document,
    debounceMs = DEFAULT_DEBOUNCE_MS,
}) {
    const options = inputData?.[1] ?? {};
    const widget = {
        name: inputName,
        type: PATH_WIDGET_TYPE,
        value: options.default ?? "",
        options,
        draw(context, drawNode, width, y, height) {
            return drawPathWidget.call(
                this,
                context,
                drawNode,
                width,
                y,
                height,
                app,
            );
        },
        mouse(mouseEvent, _position, mouseNode) {
            if (this.disabled) {
                return false;
            }
            if (app.canvas) {
                app.canvas.node_widget = null;
            }
            openPathDialog({
                widget: this,
                node: mouseNode ?? this.fhsPathNode,
                event: mouseEvent,
                app,
                api,
                documentRef,
                debounceMs,
            });
            return true;
        },
        fhsPathNode: node,
    };

    if (!node.widgets) {
        node.widgets = [];
    }
    node.widgets.push(widget);
    return widget;
}


export function createServerPathWidgetFactory(dependencies) {
    return function serverPathWidgetFactory(node, inputName, inputData) {
        return createServerPathWidget({
            node,
            inputName,
            inputData,
            ...dependencies,
        });
    };
}


export function replaceServerPathWidget({
    widget,
    node,
    inputData,
    app,
    api,
    factory,
    documentRef = globalThis.document,
    debounceMs = DEFAULT_DEBOUNCE_MS,
}) {
    const widgetIndex = node.widgets?.indexOf(widget) ?? -1;
    if (!widget || widgetIndex < 0) {
        return { widget, cleanup: () => {} };
    }

    const options = {
        ...(inputData?.[1] ?? {}),
        ...(widget.options ?? {}),
    };
    const holder = {};
    const createWidget = factory ?? createServerPathWidgetFactory({
        app,
        api,
        documentRef,
        debounceMs,
    });
    const replacement = createWidget(
        holder,
        widget.name,
        [PATH_WIDGET_FACTORY, options],
    );
    if (!replacement || typeof replacement !== "object") {
        throw new TypeError("The FHS path widget factory returned no widget.");
    }

    replacement.fhsPathNode = node;
    replacement.value = widget.value ?? replacement.value;
    replacement.config = widget.config ?? inputData;
    replacement.inputData = widget.inputData ?? inputData;
    for (const property of [
        "callback",
        "serialize",
        "linkedWidgets",
        "label",
        "disabled",
    ]) {
        if (property in widget) {
            replacement[property] = widget[property];
        }
    }

    node.widgets[widgetIndex] = replacement;
    return {
        widget: replacement,
        cleanup: () => closeActiveDialog(replacement),
    };
}
