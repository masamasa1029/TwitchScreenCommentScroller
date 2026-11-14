const fs = require('fs');
const vm = require('vm');
const fakeEl = () => ({
  style: {}, children: [], dataset: {},
  setAttribute() {}, appendChild(c) { this.children.push(c); return c; },
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  closest() { return null; }, remove() {}, getClientRects() { return []; },
});
const sandbox = {
  console,
  GM_getValue: (k, d) => d,
  GM_setValue: () => {},
  GM_registerMenuCommand: () => {},
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  performance, setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  location: { href: 'https://www.twitch.tv/example' },
  NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
  Node: { TEXT_NODE: 3 },
  OffscreenCanvas: class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return null; } },
  Image: class {},
  HTMLImageElement: class {},
  Element: class {},
  WeakSet, Map, Set,
};
sandbox.window = sandbox;
sandbox.document = {
  body: fakeEl(), head: fakeEl(), documentElement: fakeEl(),
  getElementById: () => null,
  createElement: () => fakeEl(),
  querySelector: () => null,
  querySelectorAll: () => [],
};
sandbox.window.devicePixelRatio = 2;
sandbox.window.addEventListener = () => {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), sandbox);
console.log('LOAD_OK: script initialized without errors');
