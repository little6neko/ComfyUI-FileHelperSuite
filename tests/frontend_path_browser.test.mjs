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
const { enhanceServerPathWidget, PATH_WIDGET_TYPE } = await import(moduleUrl);


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


function makeHarness(fetchApi) {
    const documentRef = new FakeDocument();
    const callbackValues = [];
    const widget = {
        name: "image",
        type: "text",
        value: "",
        options: { placeholder: "X://path/to/image.png" },
        callback(value) {
            callbackValues.push(value);
        },
    };
    const dirtyCalls = [];
    const node = {
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
    const cleanup = enhanceServerPathWidget({
        widget,
        node,
        app,
        api: { fetchApi },
        documentRef,
        debounceMs: 0,
    });
    return {
        app,
        callbackValues,
        cleanup,
        dirtyCalls,
        documentRef,
        node,
        widget,
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


async function waitFor(predicate, timeoutMs = 500) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error("Timed out waiting for frontend state");
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}


test("opens one dialog and commits a selected image", async () => {
    const listing = {
        directory: "/srv",
        parent: "/",
        remainder: "",
        entries: [
            { name: "images", path: "/srv/images", kind: "directory" },
            { name: "sample.png", path: "/srv/sample.png", kind: "file" },
        ],
    };
    const harness = makeHarness(async () => okResponse(listing));

    assert.equal(harness.widget.type, PATH_WIDGET_TYPE);
    harness.widget.mouse({ clientX: 100, clientY: 120 });
    harness.widget.mouse({ clientX: 100, clientY: 120 });
    assert.equal(harness.documentRef.body.children.length, 1);

    await waitFor(() => (
        harness.widget.fhsPathBrowserState?.entries.children.length === 3
    ));
    const state = harness.widget.fhsPathBrowserState;
    const fileEntry = state.entries.children.find(
        (entry) => entry.fhsPathEntry?.kind === "file",
    );
    await fileEntry.dispatch("click");

    assert.equal(harness.widget.value, "/srv/sample.png");
    assert.deepEqual(harness.callbackValues, ["/srv/sample.png"]);
    assert.deepEqual(harness.dirtyCalls, [[true, true]]);
    assert.equal(harness.documentRef.body.children.length, 0);
    assert.equal(harness.widget.fhsPathBrowserState, undefined);
});


test("navigates directories using server-provided paths", async () => {
    const requestedPaths = [];
    const harness = makeHarness(async (url) => {
        const requestUrl = new URL(url, "http://localhost");
        const path = requestUrl.searchParams.get("path");
        requestedPaths.push(path);
        if (path === "/srv/images") {
            return okResponse({
                directory: "/srv/images",
                parent: "/srv",
                remainder: "",
                entries: [
                    {
                        name: "chosen.webp",
                        path: "/srv/images/chosen.webp",
                        kind: "file",
                    },
                ],
            });
        }
        return okResponse({
            directory: "/srv",
            parent: "/",
            remainder: "",
            entries: [
                { name: "images", path: "/srv/images", kind: "directory" },
            ],
        });
    });

    harness.widget.mouse({ clientX: 20, clientY: 20 });
    await waitFor(() => (
        harness.widget.fhsPathBrowserState?.entries.children.length === 2
    ));
    const directoryEntry = harness.widget.fhsPathBrowserState.entries.children.find(
        (entry) => entry.fhsPathEntry?.path === "/srv/images",
    );
    await directoryEntry.dispatch("click");
    await waitFor(() => requestedPaths.includes("/srv/images"));
    await waitFor(() => harness.widget.fhsPathBrowserState.entries.children.some(
        (entry) => entry.fhsPathEntry?.kind === "file",
    ));

    const fileEntry = harness.widget.fhsPathBrowserState.entries.children.find(
        (entry) => entry.fhsPathEntry?.kind === "file",
    );
    await fileEntry.dispatch("click");

    assert.equal(harness.widget.value, "/srv/images/chosen.webp");
    assert.deepEqual(requestedPaths, ["", "/srv/images"]);
});


test("ignores a stale directory response after the path changes", async () => {
    let resolveFirstRequest;
    let requestCount = 0;
    const harness = makeHarness(async () => {
        requestCount += 1;
        if (requestCount === 1) {
            return await new Promise((resolve) => {
                resolveFirstRequest = () => resolve(okResponse({
                    directory: "/old",
                    parent: "/",
                    remainder: "",
                    entries: [
                        { name: "old.png", path: "/old/old.png", kind: "file" },
                    ],
                }));
            });
        }
        return okResponse({
            directory: "/new",
            parent: "/",
            remainder: "",
            entries: [
                { name: "new.png", path: "/new/new.png", kind: "file" },
            ],
        });
    });

    harness.widget.mouse({ clientX: 20, clientY: 20 });
    await waitFor(() => typeof resolveFirstRequest === "function");
    const state = harness.widget.fhsPathBrowserState;
    state.input.value = "/new";
    await state.input.dispatch("input");
    await waitFor(() => requestCount === 2);
    await waitFor(() => state.entries.children.some(
        (entry) => entry.textContent === "new.png",
    ));

    resolveFirstRequest();
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(
        state.entries.children.some((entry) => entry.textContent === "old.png"),
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

    harness.widget.mouse({ clientX: 20, clientY: 20 });
    await waitFor(() => (
        harness.widget.fhsPathBrowserState?.status.textContent
        === "Directory is not accessible"
    ));
    let state = harness.widget.fhsPathBrowserState;
    state.input.value = "relative/image.png";
    await state.input.dispatch("keydown", { key: "Enter" });
    assert.equal(harness.widget.value, "relative/image.png");

    harness.widget.mouse({ clientX: 20, clientY: 20 });
    state = harness.widget.fhsPathBrowserState;
    state.input.value = "should-not-commit.png";
    await state.input.dispatch("keydown", { key: "Escape" });
    assert.equal(harness.widget.value, "relative/image.png");

    harness.widget.mouse({ clientX: 20, clientY: 20 });
    await waitFor(() => requestSignals.length >= 2);
    const latestSignal = requestSignals.at(-1);
    harness.cleanup();
    assert.equal(latestSignal.aborted, true);
    assert.equal(harness.widget.type, "text");
    assert.equal(harness.documentRef.body.children.length, 0);
});
