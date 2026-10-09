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

  // --- 3. ES6 modules (REAL execution test, not an attribute check) -----
  // The old probe ("script.type === 'module'") was a false positive: the DOM
  // accepts ANY string on script.type and echoes it back because type is a
  // plain reflected attribute - it proves nothing about module loading.
  // This probe appends <script type="module"> elements with inline content
  // that performs actual module work (import.meta resolution, static import
  // of a data: URL, dynamic import()) and reports whether their code ever
  // executed via window flags. On JavaFX WebKit (JSC + Qt network layer)
  // inline/data/relative module loads are known to fail even though the
  // engine parses ESM syntax - which is exactly what this distinguishes.
  // Results land in es6ModulesInline / es6ModulesImportMeta /
  // es6ModulesDataImport / es6ModulesDynamicImport plus two derived fields:
  //   es6ModulesSyntax      -> does JSC parse ESM source at all?
  //   es6Modules            -> can WebEngine actually EXECUTE module scripts?
  window.__probeModuleFlags = {};

  // Synchronous syntax-level check: does the parser accept module-only
  // source? import.meta / import-declarations are SyntaxErrors in script
  // mode on EVERY engine, so we compile them through new Function() and
  // classify the error: a *SyntaxError mentioning the module construct*
  // proves the parser knows ESM grammar; any other outcome (e.g. an engine
  // that parses it happily in script mode, or no error at all) is reported
  // as unknown/false. This distinguishes "engine understands ESM syntax"
  // from "engine runs module scripts" (the async flags below).
  probe("es6ModulesSyntax", function () {
    var sawImportMetaSyntaxError = false;
    var sawImportDeclSyntaxError = false;
    try { new Function("return import.meta.url;"); }
    catch (e) {
      sawImportMetaSyntaxError = (e instanceof SyntaxError) &&
        String(e.message).toLowerCase().indexOf("import") !== -1;
    }
    try { new Function("import 'x';"); }
    catch (e) {
      sawImportDeclSyntaxError = (e instanceof SyntaxError) &&
        String(e.message).toLowerCase().indexOf("import") !== -1;
    }
    return sawImportMetaSyntaxError || sawImportDeclSyntaxError;
  });

  function injectModule(id, code) {
    try {
      var s = document.createElement("script");
      s.type = "module";
      s.textContent = code;
      document.head.appendChild(s);
      return true;
    } catch (e) {
      results["es6Modules_inject_error"] = String(e && e.message ? e : e);
      return false;
    }
  }

  // Each flag becomes true ONLY if the module body actually ran.
  injectModule("inline", "window.__probeModuleFlags.inline = true;");
  injectModule("importMeta",
    "window.__probeModuleFlags.importMeta = (typeof import.meta.url === 'string');");
  injectModule("dataImport",
    "import 'data:text/javascript,window.__probeModuleFlags.dataImport = true;';");
  injectModule("dynamicImport",
    "import('data:text/javascript,').then(function(){ window.__probeModuleFlags.dynamicImport = true; }, " +
    "function(){ window.__probeModuleFlags.dynamicImportFail = true; });");

  // Asynchronous probes need the host to wait before collecting results.
  results.__async = true;
  results.__asyncWaitMs = 500;

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

  // --- 7. Collector (runs on the FX thread after the host waited for the
  //         async module probes to settle) ---------------------------------
  window.__collectProbeResults = function () {
    var f = window.__probeModuleFlags || {};
    results.es6ModulesInline = f.inline === true;
    results.es6ModulesImportMeta = f.importMeta === true;
    results.es6ModulesDataImport = f.dataImport === true;
    results.es6ModulesDynamicImport = f.dynamicImport === true;
    results.es6ModulesDynamicImportRejected = f.dynamicImportFail === true;
    // Verdict: modules are usable in this engine only if an inline module
    // script actually executed AND import.meta resolved. The old attribute
    // check was a false positive - this one cannot be spoofed by the DOM.
    results.es6Modules = results.es6ModulesInline && results.es6ModulesImportMeta;
    delete results.__async;
    delete results.__asyncWaitMs;
    return JSON.stringify(results);
  };

  // Return a placeholder so executeScript() does not choke on undefined;
  // the host calls __collectProbeResults() after the wait period.
  return JSON.stringify({ pending: true });
})();
