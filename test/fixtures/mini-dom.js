// A DOM small enough to run board/paste-chips.js in node: no dependencency, no browser.
//
// WHY THIS EXISTS. The chip keydown handler is a DOM contract - a caret, a non-editable atom beside it, a word
// around it - and the defect it fixes can only be stated in those terms. jsdom is not a dependency of this repo
// (package.json has none), and the suite must run on a machine with no browser, so this is the slice of DOM the
// module actually touches: elements with a dataset, text nodes, ranges over the flat content of a box, one
// selection, and events that bubble to the document.
//
// It is deliberately small. It supports the flat shape the chip boxes have - text nodes and chips as siblings
// under the box - and it refuses (returns -1 / throws) rather than guessing at nested editing structures.
//
// Usage:
//   import { createDom } from "./fixtures/mini-dom.js";
//   const dom = createDom();
//   const box = dom.document.createElement("div");
//   dom.document.body.appendChild(box);

export function createDom() {
  let selection = null;

  class MiniText {
    constructor(data) {
      this.nodeType = 3;
      this.data = String(data == null ? "" : data);
      this.parentNode = null;
    }
    get textContent() {
      return this.data;
    }
    set textContent(v) {
      this.data = String(v == null ? "" : v);
    }
    get previousSibling() {
      return siblingOf(this, -1);
    }
    get nextSibling() {
      return siblingOf(this, 1);
    }
    remove() {
      detach(this);
    }
    dispatchEvent() {
      return true;
    }
    focus() {
      /* a text node is never focused */
    }
  }

  class MiniElement {
    constructor(tag, ownerDocument) {
      this.nodeType = 1;
      this.tagName = String(tag || "div").toUpperCase();
      this.ownerDocument = ownerDocument || null;
      this.childNodes = [];
      this.parentNode = null;
      this.dataset = {};
      this.className = "";
      this.attributes = {};
      this.title = "";
      this.id = "";
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get lastChild() {
      return this.childNodes[this.childNodes.length - 1] || null;
    }
    get previousSibling() {
      return siblingOf(this, -1);
    }
    get nextSibling() {
      return siblingOf(this, 1);
    }
    get classList() {
      const el = this;
      const list = () => String(el.className || "").split(/\s+/).filter(Boolean);
      return {
        contains: (c) => list().includes(c),
        add: (...cs) => {
          for (const c of cs) if (!list().includes(c)) el.className = `${el.className} ${c}`.trim();
        },
        remove: (...cs) => {
          el.className = list()
            .filter((c) => !cs.includes(c))
            .join(" ");
        },
        toggle: (c) => (list().includes(c) ? el.classList.remove(c) : el.classList.add(c)),
      };
    }
    setAttribute(name, value) {
      this.attributes[String(name)] = String(value);
      if (String(name).startsWith("data-")) this.dataset[camel(name.slice(5))] = String(value);
      if (name === "id") this.id = String(value);
      if (name === "class") this.className = String(value);
    }
    getAttribute(name) {
      if (name === "class") return this.className || null;
      if (name === "id") return this.id || null;
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }
    appendChild(node) {
      detach(node);
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }
    insertBefore(node, ref) {
      if (!ref) return this.appendChild(node);
      detach(node);
      const at = this.childNodes.indexOf(ref);
      if (at < 0) return this.appendChild(node);
      node.parentNode = this;
      this.childNodes.splice(at, 0, node);
      return node;
    }
    removeChild(node) {
      const at = this.childNodes.indexOf(node);
      if (at < 0) return node;
      this.childNodes.splice(at, 1);
      node.parentNode = null;
      return node;
    }
    replaceChildren(...nodes) {
      const flat = nodes.flatMap((n) => (n && n.nodeType === 11 ? n.childNodes.slice() : [n]));
      for (const child of this.childNodes.slice()) this.removeChild(child);
      for (const n of flat) if (n) this.appendChild(n);
    }
    remove() {
      detach(this);
    }
    contains(node) {
      if (!node) return false;
      if (node === this) return true;
      for (let n = node; n; n = n.parentNode) if (n === this) return true;
      return false;
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join("");
    }
    set textContent(v) {
      this.replaceChildren(new MiniText(v == null ? "" : v));
    }
    get innerHTML() {
      return this.childNodes
        .map((c) => (c.nodeType === 3 ? c.data : c.tagName === "BR" ? "<br>" : `<${c.tagName.toLowerCase()}>${c.innerHTML}</${c.tagName.toLowerCase()}>`))
        .join("");
    }
    matches(selector) {
      return matches(this, selector);
    }
    closest(selector) {
      for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, selector)) return n;
      return null;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          if (matches(child, selector)) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
    dispatchEvent(event) {
      return dispatch(this, event);
    }
    focus() {
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
      return true;
    }
    blur() {
      if (this.ownerDocument && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
    }
  }

  class MiniFragment {
    constructor() {
      this.nodeType = 11;
      this.childNodes = [];
      this.parentNode = null;
    }
    appendChild(node) {
      detach(node);
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join("");
    }
  }

  // ---- the flat geometry the module relies on: text offsets inside a node, child offsets inside an element ----
  const pointOf = (container, offset) => ({ container, offset });

  class MiniRange {
    constructor(doc) {
      this.ownerDocument = doc;
      this.startContainer = null;
      this.startOffset = 0;
      this.endContainer = null;
      this.endOffset = 0;
    }
    get collapsed() {
      return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
    }
    setStart(node, offset) {
      this.startContainer = node;
      this.startOffset = offset;
      if (!this.endContainer) this.setEnd(node, offset);
      this.reorder();
    }
    setEnd(node, offset) {
      this.endContainer = node;
      this.endOffset = offset;
      if (!this.startContainer) this.setStart(node, offset);
      this.reorder();
    }
    reorder() {
      if (!this.startContainer || !this.endContainer) return;
      if (this.startContainer === this.endContainer && this.startOffset > this.endOffset) {
        [this.startOffset, this.endOffset] = [this.endOffset, this.startOffset];
      }
    }
    setStartAfter(node) {
      const parent = node.parentNode;
      this.setStart(parent, [...parent.childNodes].indexOf(node) + 1);
    }
    setStartBefore(node) {
      const parent = node.parentNode;
      this.setStart(parent, [...parent.childNodes].indexOf(node));
    }
    setEndAfter(node) {
      const parent = node.parentNode;
      this.setEnd(parent, [...parent.childNodes].indexOf(node) + 1);
    }
    setEndBefore(node) {
      const parent = node.parentNode;
      this.setEnd(parent, [...parent.childNodes].indexOf(node));
    }
    collapse(toStart = true) {
      if (toStart) this.endContainer = this.startContainer, (this.endOffset = this.startOffset);
      else this.startContainer = this.endContainer, (this.startOffset = this.endOffset);
    }
    selectNodeContents(node) {
      if (node.nodeType === 3) {
        this.setStart(node, 0);
        this.setEnd(node, node.data.length);
        return;
      }
      this.setStart(node, 0);
      this.setEnd(node, node.childNodes.length);
    }
    insertNode(node) {
      const container = this.startContainer;
      const offset = this.startOffset;
      if (container.nodeType === 3) {
        const parent = container.parentNode;
        const tail = new MiniText(container.data.slice(offset));
        container.data = container.data.slice(0, offset);
        const at = parent.childNodes.indexOf(container);
        parent.insertBefore(node, parent.childNodes[at + 1] || null);
        parent.insertBefore(tail, node.nextSibling);
      } else {
        container.insertBefore(node, container.childNodes[offset] || null);
      }
    }
    deleteContents() {
      const { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo } = this;
      if (!sc || !ec) return;
      if (sc === ec && sc.nodeType === 3) {
        sc.data = sc.data.slice(0, so) + sc.data.slice(eo);
        this.setEnd(sc, so);
        return;
      }
      if (sc === ec) {
        for (const child of sc.childNodes.slice(so, eo)) sc.removeChild(child);
        this.setEnd(sc, so);
        return;
      }
      const parent = sc.nodeType === 3 ? sc.parentNode : sc;
      const other = ec.nodeType === 3 ? ec.parentNode : ec;
      if (parent !== other) throw new Error("mini-dom: deleteContents across parents is not supported");
      if (sc.nodeType === 3) sc.data = sc.data.slice(0, so);
      if (ec.nodeType === 3) ec.data = ec.data.slice(eo);
      const kids = parent.childNodes;
      const from = sc.nodeType === 3 ? kids.indexOf(sc) : so;
      const to = ec.nodeType === 3 ? kids.indexOf(ec) : eo;
      for (let i = to - 1; i > from; i -= 1) parent.removeChild(kids[i]);
      this.setEnd(sc.nodeType === 3 ? sc : parent, sc.nodeType === 3 ? so : so);
    }
    toString() {
      const { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo } = this;
      if (!sc || !ec) return "";
      if (sc === ec && sc.nodeType === 3) return sc.data.slice(so, eo);
      if (sc === ec) return sc.childNodes.slice(so, eo).map((n) => n.textContent).join("");
      if (sc.nodeType === 3 && ec.nodeType === 3 && sc.parentNode === ec.parentNode) {
        const kids = sc.parentNode.childNodes;
        const out = [sc.data.slice(so)];
        for (let i = kids.indexOf(sc) + 1; i < kids.indexOf(ec); i += 1) out.push(kids[i].textContent);
        out.push(ec.data.slice(0, eo));
        return out.join("");
      }
      return "";
    }
  }

  class MiniSelection {
    constructor(doc) {
      this.ownerDocument = doc;
      this.ranges = [];
    }
    get rangeCount() {
      return this.ranges.length;
    }
    get isCollapsed() {
      return this.ranges.length === 1 && this.ranges[0].collapsed;
    }
    get anchorNode() {
      return this.ranges[0] ? this.ranges[0].startContainer : null;
    }
    get anchorOffset() {
      return this.ranges[0] ? this.ranges[0].startOffset : 0;
    }
    getRangeAt(i) {
      return this.ranges[i];
    }
    removeAllRanges() {
      this.ranges = [];
    }
    addRange(range) {
      this.ranges = [range];
    }
    collapse(node, offset) {
      const r = new MiniRange(this.ownerDocument);
      r.setStart(node, offset);
      r.collapse(true);
      this.ranges = [r];
    }
    extend() {
      /* not modelled */
    }
  }

  function siblingOf(node, dir) {
    const parent = node.parentNode;
    if (!parent) return null;
    const at = parent.childNodes.indexOf(node);
    return parent.childNodes[at + dir] || null;
  }
  function detach(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }
  function camel(name) {
    return String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  // A compound selector only: `tag.class.class[attr]`, `.class`, `[data-thing]`. Enough for every lookup the
  // module makes, and an unsupported selector matches nothing rather than throwing.
  function matches(el, selector) {
    if (!el || el.nodeType !== 1) return false;
    for (const part of String(selector).split(",").map((s) => s.trim()).filter(Boolean)) {
      const m = /^([a-zA-Z]+)?((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/.exec(part);
      if (!m) continue;
      const [, tag, classes, attrs] = m;
      if (tag && el.tagName !== tag.toUpperCase()) continue;
      const list = String(el.className || "").split(/\s+/).filter(Boolean);
      const wanted = (classes.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
      if (wanted.some((c) => !list.includes(c))) continue;
      const attrNames = (attrs.match(/\[[\w-]+\]/g) || []).map((a) => a.slice(1, -1));
      const missing = attrNames.some((name) => {
        const key = name.startsWith("data-") ? camel(name.slice(5)) : name;
        const v = name.startsWith("data-") ? el.dataset[key] : el.getAttribute(name);
        return v === undefined || v === null || v === "";
      });
      if (missing) continue;
      return true;
    }
    return false;
  }

  function listenersFor(store, type) {
    if (!store.has(type)) store.set(type, []);
    return store.get(type);
  }

  function dispatch(target, event) {
    if (!event || !event.type) return true;
    const path = [];
    for (let n = target; n; n = n.parentNode) path.push(n);
    if (!path.includes(document)) path.push(document);
    event.target = event.target || target;
    for (const node of path) {
      const store = node === document ? documentListeners : node.__listeners;
      if (!store) continue;
      for (const fn of listenersFor(store, event.type).slice()) {
        fn.call(node, event);
        if (event.cancelled) return !event.defaultPrevented;
      }
    }
    return !event.defaultPrevented;
  }

  const documentListeners = new Map();
  const document = {
    nodeType: 9,
    activeElement: null,
    createElement(tag) {
      return new MiniElement(tag, document);
    },
    createTextNode(text) {
      return new MiniText(text);
    },
    createDocumentFragment() {
      return new MiniFragment();
    },
    createRange() {
      return new MiniRange(document);
    },
    querySelector(selector) {
      return document.body.querySelector(selector);
    },
    querySelectorAll(selector) {
      return document.body ? document.body.querySelectorAll(selector) : [];
    },
    addEventListener(type, fn) {
      listenersFor(documentListeners, type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listenersFor(documentListeners, type);
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    dispatchEvent(event) {
      return dispatch(document, event);
    },
    getSelection() {
      return selection;
    },
    getElementById(id) {
      return document.querySelector(`#${id}`);
    },
  };
  document.body = new MiniElement("body", document);
  document.documentElement = new MiniElement("html", document);
  document.documentElement.appendChild(document.body);
  selection = new MiniSelection(document);

  class MiniEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = init.bubbles !== false;
      this.cancelable = init.cancelable !== false;
      this.defaultPrevented = false;
      this.cancelled = false;
      this.target = null;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
    stopPropagation() {
      this.cancelled = true;
    }
    stopImmediatePropagation() {
      this.cancelled = true;
    }
  }

  const window = {
    getSelection: () => selection,
    document,
  };

  return { document, window, MiniEvent, MiniRange, MiniSelection, MiniElement, MiniText };
}
