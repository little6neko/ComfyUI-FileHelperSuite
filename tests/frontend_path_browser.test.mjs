import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const source = await readFile(
    new URL("../web/js/server_path_browser.js", import.meta.url),
    "utf8",
);
const moduleUrl = (
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const {
    PATH_WIDGET_FACTORY,
    PATH_WIDGET_TYPE,
    createServerPathWidgetFactory,
    replaceServerPathWidget,
} = await import(moduleUrl);


class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.listeners = new Map();
        this.style = {};
        this.className = "";
        this.textContent = "";
        this.title = "";
        this.value = "";
        this.parentElement = undefined;
        this.isConnected = false;
    }

    append(...children) {
        for (const child of children) {
            child.parentElement = this;
            child.setConnected(this.isConnected);
            this.children.push(child);
        }
    }

    replaceChildren(...children) {
        for (const child of this.children) {
            child.parentElement = undefined;
            child.setConnected(false);
        }
        this.children = [];
        this.append(...children);
    }

    setConnected(value) {
        this.isConnected = value;
        for (const child of this.children) {
            child.setConnected(value);
        }
    }

    remove() {
        if (this.parentElement) {
            this.parentElement.children = this.parentElement.children.filter(
                (child) => child !== this,
            );
        }
        this.parentElement = undefined;
        this.setConnected(false);
    }

    addEventListener(type, callback) {
        const callbacks = this.listeners.get(type) ?? [];
        callbacks.push(callback);
        this.listeners.set(type, callbacks);
    }

    async dispatch(type, values = {}) {
        const event = {
            preventDefault() {},
            stopPropagation() {},
            ...values,
        };
        for (const callback of this.listeners.get(type) ?? []) {
            await callback(event);
        }
    }

    focus() {
        this.focused = true;
    }
}


class FakeDocument {
    constructor() {
        this.body = new FakeElement("body");
        this.body.setConnected(true);
    }

    createElement(tagName) {
        return new FakeElement(tagName);
    }
}


function makeHarness(fetchApi, { initialValue = "" } = {}) {
    const documentRef = new FakeDocument();
    const callbackValues = [];
    const nativeCalls = [];
    const serializeValue = async () => oldWidget.value;
    const oldWidget = {
        name: "image",
        type: "text",
        value: initialValue,
        options: { placeholder: "X://path/to/image.png" },
        config: ["STRING", { default: "", fhs_path: true }],
        serialize: true,
        serializeValue,
        callback(value) {
            callbackValues.push(value);
        },
        mouse() {
            nativeCalls.push("mouse");
        },
        onPointerDown() {
            nativeCalls.push("pointer");
        },
        onClick() {
            nativeCalls.push("click");
        },
        prompt: true,
    };
    const beforeWidget = { name: "before" };
    const afterWidget = { name: "after" };
    const dirtyCalls = [];
    const node = {
        widgets: [beforeWidget, oldWidget, afterWidget],
        graph: {
            setDirtyCanvas(...args) {
                dirtyCalls.push(args);
            },
        },
    };
    const app = {
        canvas: {
            node_widget: {},
            ds: { scale: 1 },
            canvas: {
                getBoundingClientRect() {
                    return { left: 0, top: 0, width: 800, height: 600 };
                },
            },
        },
    };
    const inputData = [
        "STRING",
        {
            default: "",
            placeholder: "X://path/to/image.png",
            fhs_path: true,
        },
    ];
    const factory = createServerPathWidgetFactory({
        app,
        api: { fetchApi },
        documentRef,
        debounceMs: 0,
    });
    const replacement = replaceServerPathWidget({
        widget: oldWidget,
        node,
        inputData,
        app,
        api: { fetchApi },
        factory,
        documentRef,
        debounceMs: 0,
    });
    return {
        ...replacement,
        afterWidget,
        app,
        beforeWidget,
        callbackValues,
        dirtyCalls,
        documentRef,
        nativeCalls,
        node,
        oldWidget,
        serializeValue,
    };
}


function okResponse(listing) {
    return {
        ok: true,
        status: 200,
        async json() {
            return listing;
        },
    };
}


test("IME refreshes candidates during composition without touching text", async () => {
    let finishInitial;
    let requests = 0;
    const listing = {
        directory: "input/", value: "input/", parent: "", remainder: "",
        entries: [{ name: "sample.png", path: "input/sample.png", kind: "file" }],
    };
    const harness = makeHarness(async () => {
        requests++;
        if (requests === 1) return new Promise(resolve => {
            finishInitial = () => resolve(okResponse(listing));
        });
        return okResponse(listing);
    });
    try {
        harness.widget.mouse({});
        await waitFor(() => finishInitial);
        const state = harness.widget.fhsPathBrowserState;
        await state.input.dispatch("compositionstart");
        state.input.value = "input";
        let inputWrites = 0;
        let currentText = state.input.value;
        Object.defineProperty(state.input, "value", {
            get: () => currentText,
            set: value => { inputWrites++; currentText = value; },
        });
        await state.input.dispatch("input", { isComposing: true });
        await state.input.dispatch("keydown", { key: "Enter", isComposing: true });
        await state.input.dispatch("keydown", { key: "Escape", isComposing: true });
        assert.equal(harness.documentRef.body.children.length, 1);
        assert.deepEqual(harness.callbackValues, []);
        await waitFor(() => state.helper.children.some(
            entry => entry.fhsPathEntry?.kind === "file",
        ));
        assert.equal(state.composing, true);
        assert.equal(requests, 2);
        finishInitial();
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(state.input.value, "input");
        assert.equal(inputWrites, 0);
        await state.input.dispatch("keydown", { key: "Shift", isComposing: true });
        await state.input.dispatch("compositionend");
        await state.input.dispatch("input", { isComposing: false });
        await waitFor(() => requests === 3);
        assert.equal(state.input.value, "input");
        assert.equal(inputWrites, 0);
        await state.input.dispatch("keydown", { key: "Enter" });
        assert.equal(harness.widget.value, "input");
    } finally {
        harness.cleanup();
    }
});


test("typing never writes a canonical directory back into the input", async () => {
    const harness = makeHarness(async () => okResponse({
        directory: "input/", value: "input/", parent: "", remainder: "",
        entries: [{ name: "sample.png", path: "input/sample.png", kind: "file" }],
    }));
    try {
        harness.widget.mouse({});
        const state = harness.widget.fhsPathBrowserState;
        state.input.value = "input";
        state.input.selectionStart = 2;
        state.input.selectionEnd = 2;
        await state.input.dispatch("input");
        await waitFor(() => state.helper.children.some(
            entry => entry.fhsPathEntry?.kind === "file",
        ));
        assert.equal(state.input.value, "input");
        assert.equal(state.input.selectionStart, 2);
        assert.equal(state.input.selectionEnd, 2);
    } finally {
        harness.cleanup();
    }
});


async function waitFor(predicate, timeoutMs = 500) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error("Timed out waiting for frontend state");
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}


async function promptWidgetValue(widget, node, index) {
    return widget.serializeValue
        ? await widget.serializeValue(node, index)
        : widget.value;
}


test("replaces the native text widget at the same index", async () => {
    const harness = makeHarness(async () => okResponse({
        directory: "",
        value: "",
        parent: null,
        remainder: "",
        entries: [],
    }));

    assert.equal(PATH_WIDGET_FACTORY, "FHSPATH");
    assert.equal(harness.node.widgets.length, 3);
    assert.equal(harness.node.widgets[0], harness.beforeWidget);
    assert.equal(harness.node.widgets[1], harness.widget);
    assert.equal(harness.node.widgets[2], harness.afterWidget);
    assert.notEqual(harness.widget, harness.oldWidget);
    assert.equal(harness.widget.type, PATH_WIDGET_TYPE);
    assert.equal(harness.widget.serialize, true);
    assert.equal("serializeValue" in harness.widget, false);
    assert.equal(harness.widget.config, harness.oldWidget.config);
    assert.notEqual(harness.widget.mouse, harness.oldWidget.mouse);
    assert.equal("onPointerDown" in harness.widget, false);
    assert.equal("onClick" in harness.widget, false);
    assert.equal("prompt" in harness.widget, false);
    assert.deepEqual(harness.nativeCalls, []);

    harness.widget.value = "input/new-selection.png";
    assert.equal(
        await promptWidgetValue(harness.widget, harness.node, 1),
        "input/new-selection.png",
    );
    assert.equal(await harness.serializeValue(), "");
    harness.cleanup();
});


test("restored workflow paths serialize from the replacement widget", async () => {
    const harness = makeHarness(async () => okResponse({
        directory: "",
        value: "",
        parent: null,
        remainder: "",
        entries: [],
    }));

    harness.widget.value = "input/restored-workflow.png";

    assert.equal(
        await promptWidgetValue(harness.widget, harness.node, 1),
        "input/restored-workflow.png",
    );
    assert.equal(harness.oldWidget.value, "");
    harness.cleanup();
});


test("one click path control has the exact four-part dialog", async () => {
    const listing = {
        directory: "",
        value: "",
        parent: null,
        remainder: "",
        entries: [
            { name: "input", path: "input/", kind: "directory" },
            { name: "sample.png", path: "sample.png", kind: "file" },
        ],
    };
    const harness = makeHarness(async () => okResponse(listing));

    harness.widget.mouse({ clientX: 100, clientY: 120 }, [0, 0], harness.node);
    harness.widget.mouse({ clientX: 100, clientY: 120 }, [0, 0], harness.node);
    assert.equal(harness.documentRef.body.children.length, 1);
    assert.deepEqual(harness.nativeCalls, []);

    const state = harness.widget.fhsPathBrowserState;
    assert.equal(state.dialog.className, "litegraph litesearchbox graphdialog rounded");
    assert.deepEqual(
        state.dialog.children.map((element) => element.tagName),
        ["span", "input", "button", "div"],
    );
    assert.equal(state.dialog.children[0].className, "name");
    assert.equal(state.dialog.children[0].textContent, "Path");
    assert.equal(state.dialog.children[1].className, "value");
    assert.equal(state.dialog.children[2].className, "rounded");
    assert.equal(state.dialog.children[2].textContent, "OK");
    assert.equal(state.dialog.children[3].className, "helper");
    assert.equal("status" in state, false);

    await waitFor(() => state.helper.children.length === 2);
    const fileEntry = state.helper.children.find(
        (entry) => entry.fhsPathEntry?.kind === "file",
    );
    await fileEntry.dispatch("click");

    assert.equal(harness.widget.value, "sample.png");
    assert.equal(
        await promptWidgetValue(harness.widget, harness.node, 1),
        "sample.png",
    );
    assert.deepEqual(harness.callbackValues, ["sample.png"]);
    assert.deepEqual(harness.dirtyCalls, [[true, true]]);
    assert.equal(harness.documentRef.body.children.length, 0);
    assert.equal(harness.widget.fhsPathBrowserState, undefined);
});


test("canonicalizes a legacy root absolute value only on confirmation", async () => {
    const absolute = "/srv/ComfyUI/input/sample.png";
    const relative = "input/sample.png";
    const harness = makeHarness(
        async () => okResponse({
            directory: "input/",
            value: relative,
            parent: "",
            remainder: "sample.png",
            entries: [
                { name: "sample.png", path: relative, kind: "file" },
            ],
        }),
        { initialValue: absolute },
    );

    harness.widget.mouse({ clientX: 20, clientY: 20 }, [0, 0], harness.node);
    await waitFor(() => (
        harness.widget.fhsPathBrowserState?.input.value === relative
    ));
    const state = harness.widget.fhsPathBrowserState;

    assert.equal(harness.widget.value, absolute);
    await state.confirmButton.dispatch("click");
    assert.equal(harness.widget.value, relative);
    assert.deepEqual(harness.callbackValues, [relative]);
});


test("navigates directories using server-provided relative paths", async () => {
    const requestedPaths = [];
    const harness = makeHarness(async (url) => {
        const requestUrl = new URL(url, "http://localhost");
        const path = requestUrl.searchParams.get("path");
        requestedPaths.push(path);
        if (path === "input/") {
            return okResponse({
                directory: "input/",
                value: "input/",
                parent: "",
                remainder: "",
                entries: [
                    {
                        name: "chosen.webp",
                        path: "input/chosen.webp",
                        kind: "file",
                    },
                ],
            });
        }
        return okResponse({
            directory: "",
            value: "",
            parent: null,
            remainder: "",
            entries: [
                { name: "input", path: "input/", kind: "directory" },
            ],
        });
    });

    harness.widget.mouse({ clientX: 20, clientY: 20 }, [0, 0], harness.node);
    await waitFor(() => (
        harness.widget.fhsPathBrowserState?.helper.children.length === 1
    ));
    const directoryEntry = harness.widget.fhsPathBrowserState.helper.children.find(
        (entry) => entry.fhsPathEntry?.path === "input/",
    );
    await directoryEntry.dispatch("click");
    await waitFor(() => requestedPaths.includes("input/"));
    await waitFor(() => harness.widget.fhsPathBrowserState.helper.children.some(
        (entry) => entry.fhsPathEntry?.kind === "file",
    ));

    const fileEntry = harness.widget.fhsPathBrowserState.helper.children.find(
        (entry) => entry.fhsPathEntry?.kind === "file",
    );
    await fileEntry.dispatch("click");

    assert.equal(harness.widget.value, "input/chosen.webp");
    assert.deepEqual(requestedPaths, ["", "input/"]);
    assert.deepEqual(harness.callbackValues, ["input/chosen.webp"]);
});


test("ignores a stale directory response after the path changes", async () => {
    let resolveFirstRequest;
    let requestCount = 0;
    const harness = makeHarness(async () => {
        requestCount += 1;
        if (requestCount === 1) {
            return await new Promise((resolve) => {
                resolveFirstRequest = () => resolve(okResponse({
                    directory: "old/",
                    value: "old/",
                    parent: "",
                    remainder: "",
                    entries: [
                        { name: "old.png", path: "old/old.png", kind: "file" },
                    ],
                }));
            });
        }
        return okResponse({
            directory: "new/",
            value: "new/",
            parent: "",
            remainder: "",
            entries: [
                { name: "new.png", path: "new/new.png", kind: "file" },
            ],
        });
    });

    harness.widget.mouse({ clientX: 20, clientY: 20 }, [0, 0], harness.node);
    await waitFor(() => typeof resolveFirstRequest === "function");
    const state = harness.widget.fhsPathBrowserState;
    state.input.value = "new/";
    await state.input.dispatch("input");
    await waitFor(() => requestCount === 2);
    await waitFor(() => state.helper.children.some(
        (entry) => entry.textContent === "new.png",
    ));

    resolveFirstRequest();
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(
        state.helper.children.some((entry) => entry.textContent === "old.png"),
        false,
    );
    harness.cleanup();
});


test("manual confirmation, escape, errors, and cleanup stay bounded", async () => {
    const requestSignals = [];
    const harness = makeHarness(async (_url, options) => {
        requestSignals.push(options.signal);
        if (requestSignals.length >= 2) {
            return await new Promise((_resolve, reject) => {
                options.signal.addEventListener("abort", () => {
                    const error = new Error("request aborted");
                    error.name = "AbortError";
                    reject(error);
                });
            });
        }
        return {
            ok: false,
            status: 403,
            async json() {
                return { error: "Directory is not accessible" };
            },
        };
    });

    harness.widget.mouse({ clientX: 20, clientY: 20 }, [0, 0], harness.node);
    await waitFor(() => (
        harness.widget.fhsPathBrowserState?.message?.textContent
        === "Directory is not accessible"
    ));
    let state = harness.widget.fhsPathBrowserState;
    assert.equal(state.dialog.children.length, 4);
    assert.equal(state.helper.children.length, 1);
    state.input.value = "relative/image.png";
    await state.input.dispatch("keydown", { key: "Enter" });
    assert.equal(harness.widget.value, "relative/image.png");

    harness.widget.mouse({ clientX: 20, clientY: 20 }, [0, 0], harness.node);
    state = harness.widget.fhsPathBrowserState;
    state.input.value = "should-not-commit.png";
    await state.input.dispatch("keydown", { key: "Escape" });
    assert.equal(harness.widget.value, "relative/image.png");

    harness.widget.mouse({ clientX: 20, clientY: 20 }, [0, 0], harness.node);
    await waitFor(() => requestSignals.length >= 2);
    const latestSignal = requestSignals.at(-1);
    harness.cleanup();
    assert.equal(latestSignal.aborted, true);
    assert.equal(harness.widget.type, PATH_WIDGET_TYPE);
    assert.equal(harness.documentRef.body.children.length, 0);
});
