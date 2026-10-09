/**
 * NexaJS WebView Edition - Capability Probe Suite
 * ------------------------------------------------
 * Pure feature-detection script designed to be injected into a JavaFX
 * WebEngine via WebEngine.executeScript(). It returns a JSON string with
 * one entry per probed capability. Every probe is wrapped in try/catch so
 * that a missing feature never aborts the whole suite.
 *
 * Design notes:
 *  - Probes use `typeof` checks whenever possible (safe even if the global
 *    does not exist at all).
 *  - Syntax-level probes (arrow functions, template literals, destructuring,
 *    classes, spread, optional chaining) are evaluated through eval() inside
 *    try/catch, because their mere presence in source would break parsing on
 *    an ES5-only engine.
 *  - The Proxy/Reflect probes go beyond existence checks and validate real
 *    semantics (trap interception), which is what NexaJS reactivity needs.
 */
(function () {
  "use strict";

  var results = {};

  function probe(name, fn) {
    try {
      results[name] = fn();
    } catch (e) {
      results[name] = false;
      results[name + "_error"] = String(e && e.message ? e.message : e);
    }
  }

  // --- 1. Proxy and Reflect (NexaJS reactivity core) -------------------
  probe("proxy", function () {
    var handler = {
      get: function (target, prop) { return target[prop]; },
      set: function (target, prop, value) { target[prop] = value; return true; }
    };
    var proxy = new Proxy({ foo: "bar" }, handler);
    var intercepted = false;
    var p2 = new Proxy({}, { get: function () { intercepted = true; return 1; } });
    void p2.anything;
    // Semantic check: trap must actually fire AND values must round-trip.
    return proxy.foo === "bar" && intercepted === true;
  });

  probe("reflect", function () {
    var obj = { x: 1 };
    return Reflect.get(obj, "x") === 1 &&
           Reflect.has(obj, "x") === true &&
           typeof Reflect.ownKeys === "function";
  });

  // --- 2. Promises / microtasks ----------------------------------------
  probe("promise", function () { return typeof Promise !== "undefined"; });
  probe("asyncAwait", function () {
    try { return eval("(async function(){ return 1; })() instanceof Promise") === true; }
    catch (e) { return false; }
  });

  // --- 3. ES6 modules (indirect signal only) ----------------------------
  probe("es6Modules", function () {
    var script = document.createElement("script");
    script.type = "module";
    return script.type === "module";
  });

  // --- 4. Modern DOM APIs ------------------------------------------------
  probe("mutationObserver", function () { return typeof MutationObserver !== "undefined"; });
  probe("intersectionObserver", function () { return typeof IntersectionObserver !== "undefined"; });
  probe("resizeObserver", function () { return typeof ResizeObserver !== "undefined"; });
  probe("fetch", function () { return typeof fetch !== "undefined"; });
  probe("xmlHttpRequest", function () { return typeof XMLHttpRequest !== "undefined"; });
  probe("setImmediate", function () { return typeof setImmediate !== "undefined"; });
  probe("requestAnimationFrame", function () { return typeof requestAnimationFrame !== "undefined"; });
  probe("customElements", function () { return typeof customElements !== "undefined" && typeof HTMLElement !== "undefined"; });
  probe("cssSupports", function () {
    return typeof CSS !== "undefined" && typeof CSS.supports === "function";
  });

  // --- 5. Language features used by the NexaJS source --------------------
  probe("weakMap", function () { return typeof WeakMap !== "undefined"; });
  probe("weakSet", function () { return typeof WeakSet !== "undefined"; });
  probe("map", function () { return typeof Map !== "undefined"; });
  probe("set", function () {
    if (typeof Set === "undefined") return false;
    var s = new Set([1, 2, 2]);
    return s.size === 2;
  });
  probe("symbol", function () { return typeof Symbol !== "undefined"; });
  probe("constLet", function () {
    try { eval("\"use strict\"; const c = 1; let l = 2; c + l;"); return true; }
    catch (e) { return false; }
  });
  probe("arrowFunctions", function () {
    try { return eval("var f = () => true; f();") === true; } catch (e) { return false; }
  });
  probe("templateLiterals", function () {
    try { return eval("var s = `test${1 + 1}`; s === 'test2';") === true; } catch (e) { return false; }
  });
  probe("destructuring", function () {
    try { return eval("var [a, b] = [1, 2]; var {c} = {c: 3}; a === 1 && b === 2 && c === 3;") === true; }
    catch (e) { return false; }
  });
  probe("defaultParams", function () {
    try { return eval("(function (x = 5) { return x; })() === 5;") === true; } catch (e) { return false; }
  });
  probe("spreadRest", function () {
    try { return eval("Math.max(...[1, 5, 2]) === 5;") === true; } catch (e) { return false; }
  });
  probe("classes", function () {
    try { return eval("class A { constructor(){ this.a = 1; } } new A().a === 1;") === true; }
    catch (e) { return false; }
  });
  probe("objectEntries", function () {
    return typeof Object.entries === "function" &&
           typeof Object.assign === "function";
  });
  probe("optionalChaining", function () {
    try { return eval("({})?.x === undefined;") === true; } catch (e) { return false; }
  });
  probe("nullishCoalescing", function () {
    try { return eval("(null ?? 'fallback') === 'fallback';") === true; } catch (e) { return false; }
  });

  // --- 6. Engine metadata -------------------------------------------------
  probe("userAgent", function () { return navigator.userAgent; });
  probe("javaBridgePresent", function () { return typeof window !== "undefined" && typeof window.java !== "undefined"; });

  return JSON.stringify(results);
})();
