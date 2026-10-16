import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  WIDGET_WINDOW_DEFAULT_HEIGHT,
  WIDGET_WINDOW_DEFAULT_WIDTH,
  clampWidgetWindowSize,
  detectWidgetSVG,
  getWidgetWindows,
  openWidgetWindow,
  resolveGlimpseEntry,
  widgetWindowTitle,
} = await createJiti(import.meta.url).import("./widget-window.ts");

function fakeWindow() {
  const handlers = { closed: [] };
  return {
    on(event, handler) {
      if (event === "closed") handlers.closed.push(handler);
    },
    close() {
      for (const handler of handlers.closed.splice(0)) handler();
    },
  };
}

function fakeGlimpseModule() {
  const opened = [];
  return {
    opened,
    async module() {
      const win = fakeWindow();
      opened.push(win);
      return { open: (html, options) => { opened.html = html; opened.options = options; return win; } };
    },
  };
}

test.afterEach(() => {
  getWidgetWindows().clear();
});

test("sizes clamp into the window bounds with defaults for missing values", () => {
  assert.deepEqual(clampWidgetWindowSize(undefined, undefined), {
    width: WIDGET_WINDOW_DEFAULT_WIDTH,
    height: WIDGET_WINDOW_DEFAULT_HEIGHT,
  });
  assert.deepEqual(clampWidgetWindowSize(100, 50), { width: 240, height: 160 });
  assert.deepEqual(clampWidgetWindowSize(9999, 9999), { width: 2200, height: 1600 });
  assert.deepEqual(clampWidgetWindowSize("640", NaN), { width: 800, height: 600 });
  assert.deepEqual(clampWidgetWindowSize(640.4, 480.6), { width: 640, height: 481 });
});

test("titles default to Widget and spell snake_case with spaces", () => {
  assert.equal(widgetWindowTitle(undefined), "Widget");
  assert.equal(widgetWindowTitle("   "), "Widget");
  assert.equal(widgetWindowTitle("sales_dashboard"), "sales dashboard");
  assert.equal(widgetWindowTitle("x".repeat(400)).length, 200);
});

test("isSVG falls back to detecting a leading <svg", () => {
  assert.equal(detectWidgetSVG("  <svg><circle/></svg>"), true);
  assert.equal(detectWidgetSVG("<div>hi</div>"), false);
  assert.equal(detectWidgetSVG("<div>hi</div>", true), true);
  assert.equal(detectWidgetSVG("<svg/>", false), false);
});

test("resolveGlimpseEntry reports a hint when every anchor fails", () => {
  const seen = [];
  assert.throws(
    () => resolveGlimpseEntry((specifier, anchor) => {
      seen.push([specifier, anchor]);
      throw new Error("not here");
    }),
    (error) => {
      assert.match(error.message, /Could not resolve the glimpseui window host/);
      assert.match(error.message, /npm install/);
      return true;
    },
  );
  // cwd package.json and this module are always anchors; the package dir joins
  // when the dependency is installed.
  assert.ok(seen.length >= 2, `tried ${seen.length} anchors`);
  assert.ok(seen.every(([specifier]) => specifier === "glimpseui"));
});

test("resolveGlimpseEntry falls through failing anchors to a working one", () => {
  const entry = resolveGlimpseEntry((specifier, anchor) => {
    if (anchor.includes("package.json")) return `/resolved/${specifier}.mjs`;
    throw new Error("not here");
  });
  assert.equal(entry, "/resolved/glimpseui.mjs");
});

test("openWidgetWindow wraps, opens and registers the window; closed removes it", async () => {
  const fake = fakeGlimpseModule();
  const wrapped = [];
  await openWidgetWindow(
    {
      code: "<div>hello</div>",
      title: "my_widget",
      width: 900,
      height: 700,
    },
    {
      resolveEntry: () => "/fake/glimpse.mjs",
      importGlimpse: async () => fake.module(),
      wrapHTML: (code, isSVG) => {
        wrapped.push({ code, isSVG });
        return `<!DOCTYPE html>${code}`;
      },
    },
  );

  assert.deepEqual(wrapped, [{ code: "<div>hello</div>", isSVG: false }]);
  assert.equal(fake.opened.html, "<!DOCTYPE html><div>hello</div>");
  assert.deepEqual(fake.opened.options, { width: 900, height: 700, title: "my widget" });
  assert.equal(getWidgetWindows().size, 1);
  assert.equal(getWidgetWindows().has(fake.opened.at(-1)), true);

  fake.opened.at(-1).close();
  assert.equal(getWidgetWindows().size, 0, "the closed event removes the window");
});

test("each call opens a new window (no reuse)", async () => {
  const fake = fakeGlimpseModule();
  const importGlimpse = async () => fake.module();
  const deps = { resolveEntry: () => "/fake/glimpse.mjs", importGlimpse, wrapHTML: (code) => code };
  await openWidgetWindow({ code: "<b>1</b>" }, deps);
  await openWidgetWindow({ code: "<b>2</b>" }, deps);
  await openWidgetWindow({ code: "<b>3</b>" }, deps);
  assert.equal(getWidgetWindows().size, 3);
});

test("an SVG code sample is detected and passed to the wrapper", async () => {
  const fake = fakeGlimpseModule();
  const wrapped = [];
  await openWidgetWindow(
    { code: "  <svg><rect/></svg>", isSVG: undefined },
    {
      resolveEntry: () => "/fake/glimpse.mjs",
      importGlimpse: async () => fake.module(),
      wrapHTML: (code, isSVG) => {
        wrapped.push(isSVG);
        return code;
      },
    },
  );
  assert.deepEqual(wrapped, [true]);
});

test("empty code is refused before anything loads", async () => {
  let resolveCalls = 0;
  await assert.rejects(
    () => openWidgetWindow({ code: "" }, {
      resolveEntry: () => {
        resolveCalls += 1;
        return "/fake/glimpse.mjs";
      },
      importGlimpse: async () => fakeGlimpseModule().module(),
      wrapHTML: (code) => code,
    }),
    /non-empty/,
  );
  assert.equal(resolveCalls, 0);
});

test("a glimpse failure propagates with its reason", async () => {
  await assert.rejects(
    () => openWidgetWindow(
      { code: "<div/>" },
      {
        resolveEntry: () => "/fake/glimpse.mjs",
        importGlimpse: async () => {
          throw new Error("Glimpse host not found at '/x'. Run 'npm run build:macos'");
        },
        wrapHTML: (code) => code,
      },
    ),
    (error) => {
      assert.match(error.message, /Could not open the widget window/);
      assert.match(error.message, /build:macos/);
      return true;
    },
  );
  assert.equal(getWidgetWindows().size, 0);
});
