import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("native preview receives decoded images and clears on empty paths", async () => {
    let extension;
    const requests = [];
    const app = { registerExtension(value) { extension = value; } };
    const api = { async fetchApi(url) {
        requests.push(url);
        return { ok: true, async blob() { return new Blob(["preview"]); } };
    } };
    const originalImage = globalThis.Image;
    globalThis.Image = class {
        set src(value) { this.url = value; queueMicrotask(() => this.onload()); }
    };
    globalThis.fhsPreviewTest = { app, api };
    const source = (await readFile(
        new URL("../web/js/load_image_path.js", import.meta.url), "utf8",
    )).replace(/import[\s\S]*?from .*?;\n/g, "");
    const prelude = `
        const { app, api } = globalThis.fhsPreviewTest;
        const PATH_WIDGET_FACTORY = "FHSPATH";
        const createServerPathWidgetFactory = () => {};
        const replaceServerPathWidget = ({ widget }) => ({
            widget, cleanup() {}
        });
    `;
    let node;
    try {
        await import("data:text/javascript;base64," +
            Buffer.from(prelude + source).toString("base64"));
        class Node {
            constructor() {
                this.widgets = [
                    { name: "image", value: "input/example.png" },
                    { name: "custom_width", value: 0 },
                    { name: "custom_height", value: 0 },
                ];
                this.size = [350, 450];
                this.graph = { setDirtyCanvas() {} };
            }
            computeSize() { return [200, 100]; }
            setSize(size) { this.size = size; }
        }
        await extension.beforeRegisterNodeDef(Node, { name: "FHS_LoadImagePath" });
        node = new Node();
        node.onNodeCreated();
        const waitFor = async (predicate) => {
            for (let i = 0; i < 100; i++) {
                if (predicate()) return;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.fail("preview did not update");
        };
        await waitFor(() => node.imgs?.length === 1);
        assert.ok(node.imgs[0] instanceof globalThis.Image);
        assert.equal(node.imageIndex, 0);
        assert.match(requests[0], /path=input%2Fexample.png/);
        assert.deepEqual(node.size, [350, 450]);
        node.widgets[0].value = "";
        node.widgets[0].callback();
        await waitFor(() => node.imgs.length === 0);
        assert.equal(node.imageIndex, null);
        assert.equal(requests.length, 1);
    } finally {
        node?.onRemoved();
        globalThis.Image = originalImage;
        delete globalThis.fhsPreviewTest;
    }
});
