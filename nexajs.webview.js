/*!
 * NexaJS WebView Extension 0.1.0
 * --------------------------------
 * Companion layer for nexajs.js (load AFTER the core, as a classic script).
 * Target: JavaFX WebView (WebKit 615.x / Safari 13 baseline as confirmed by
 * the capability probe: Proxy/Promise/async-await OK, setImmediate MISSING,
 * ESM scripts NOT executed - bundle everything as IIFE, never type="module").
 *
 * Modules (all attach to window.Nexa):
 *   Nexa.env           - environment detection (userAgent + runtime probes)
 *   polyfills          - setImmediate / queueMicrotask / requestIdleCallback
 *   Nexa.bridge        - Java <-> JS bridge (callback + promise APIs, queue)
 *   model modifiers    - .number .trim .lazy .debounce via registerModelModifier
 *   event modifiers    - .prevent .stop .self .once native in core;
 *                        .debounce .throttle registered here
 *   Nexa.format        - currency/number/percent/date helpers ($format)
 *   Nexa.storage       - localStorage with Java-backed async fallback ($storage)
 *   Nexa.ready         - ordered boot: DOM ready -> bridge ready -> callback
 *   Nexa.errorHandler  - window.onerror + unhandledrejection -> Java log
 *   start wrapper      - injects $bridge/$format/$storage/$env into root scope
 */
(function (global) {
  "use strict";

  var root = typeof global !== "undefined" ? global : this;

  // ES5-safe helpers (the core targets a real-ES5 baseline in places).
  function isNaN(v) {
    return typeof v === "number" && v !== v;
  }
  function assign(target /*, src1, src2... */) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  }

  var Nexa = root.Nexa;
  if (!Nexa) {
    console.warn("[nexajs.webview] window.Nexa not found - load nexajs.js (core) BEFORE this extension.");
    return;
  }

  // ---- Contract with the core (verified against nexajs.js @ commit repo HEAD) ----
  //   * core assigns `window.Nexa = {...}` explicitly (nexajs.js ~line 1567);
  //   * `Nexa.start(selector = "body", scope = {})` accepts an optional second
  //     argument merged into the root scope (~line 1570);
  //   * `Nexa.version` is set by the core ("0.7.0"); we expose
  //     `Nexa.webviewVersion` alongside it (never overwrite core fields);
  //   * boot guard uses our own flag `Nexa._webviewStarted` (the core does not
  //     define `_started`, so we avoid that generic name entirely).
  // =================================================================================

  // ============================================================
  // 1. ENVIRONMENT DETECTION (Nexa.env)
  // ============================================================
  var ua = (root.navigator && root.navigator.userAgent) || "";
  var fxMatch = ua.match(/JavaFX[\/ ]?(\d+(?:\.\d+)?)/i);
  var wkMatch = ua.match(/AppleWebKit\/(\d+(?:\.\d+)?)/i);
  // JavaFX WebView has no "Version/x Safari" token (it exposes "Safari/615.1"),
  // so the WebKit build number doubles as the Safari-equivalent marker.
  var safariEquivalent = wkMatch ? wkMatch[1] : null;

  function probe(fn) {
    try {
      return !!fn();
    } catch (e) {
      return false;
    }
  }

  var env = {
    userAgent: ua,
    isWebview: /JavaFX/i.test(ua),
    javafxVersion: fxMatch ? fxMatch[1] : null,
    webkitVersion: safariEquivalent, // parsed from AppleWebKit/xxx in the UA
    safariEquivalent: safariEquivalent,
    capabilities: {
      proxy: probe(function () {
        return new Proxy({}, {}) instanceof Object;
      }),
      promise: typeof Promise === "function",
      asyncAwait: probe(function () {
        return new Function("return (async function(){})()")() instanceof Promise;
      }),
      setImmediate: typeof root.setImmediate === "function",
      mutationObserver: typeof root.MutationObserver === "function",
      intersectionObserver: typeof root.IntersectionObserver === "function",
      resizeObserver: typeof root.ResizeObserver === "function",
      customElements: probe(function () {
        return !!(root.customElements && root.customElements.define);
      }),
      fetch: typeof root.fetch === "function",
      intl: typeof root.Intl !== "undefined" && !!root.Intl.NumberFormat,
      esmExecution: false // probe-verified: WebEngine does NOT run module scripts
    }
  };
  Nexa.env = env;
  Nexa.webviewVersion = "0.1.0"; // core keeps owning Nexa.version

  // ============================================================
  // 2. POLYFILLS (install only what the probe says is missing)
  // ============================================================
  if (!env.capabilities.setImmediate) {
    root.setImmediate = function (fn) {
      var args = Array.prototype.slice.call(arguments, 1);
      return setTimeout.apply(root, [fn, 0].concat(args));
    };
    root.clearImmediate = function (id) {
      clearTimeout(id);
    };
  }

  if (typeof root.queueMicrotask !== "function") {
    root.queueMicrotask = function (fn) {
      Promise.resolve()
        .then(fn)
        .catch(function (err) {
          setTimeout(function () {
            throw err;
          }, 0);
        });
    };
  }

  if (typeof root.requestIdleCallback !== "function") {
    root.requestIdleCallback = function (cb) {
      var start = Date.now();
      return setTimeout(function () {
        cb({
          didTimeout: false,
          timeRemaining: function () {
            return Math.max(0, 50 - (Date.now() - start));
          }
        });
      }, 1);
    };
    root.cancelIdleCallback = function (id) {
      clearTimeout(id);
    };
  }

  // ============================================================
  // 3. JAVA-JS BRIDGE (Nexa.bridge)
  // ============================================================
  // Java side contract (documented, implemented on the JVM):
  //   window.nexaNative.invoke(method, jsonArgs, jsCallback)
  //     jsCallback receives a JSON string: {ok:true, result:...} | {ok:false, error:"..."}
  //   Java processes on a worker thread and replies via Platform.runLater.
  //   PREFERRED: right after injecting nexaNative, Java must call
  //     window.nexaBridgeReady()   -> instant activation, no polling needed.
  //   The short rAF+interval watcher below is only a fallback for older JVM code.
  var pendingQueue = []; // calls made before injection
  var readyCallbacks = [];
  var bridgeReady = false;
  var DEFAULT_CALL_TIMEOUT_MS = 10000;

  function nativeBridge() {
    return root.nexaNative || null;
  }

  function markReady() {
    if (bridgeReady) return;
    bridgeReady = true;
    // Flush queued calls in order.
    while (pendingQueue.length) {
      var item = pendingQueue.shift();
      bridge.call(item.method, item.args, item.callback);
    }
    readyCallbacks.forEach(function (cb) {
      try {
        cb();
      } catch (e) {
        console.error("[nexajs.bridge] onReady error:", e);
      }
    });
    readyCallbacks = [];
  }

  // Explicit notification API for the Java side (preferred over polling).
  root.nexaBridgeReady = function () {
    stopWatching();
    markReady();
  };

  // Fallback watcher: first animation frames (injection usually lands within
  // them), then a cheap slow poll; gives up after ~5s with a loud warning.
  var watchTimer = null;
  var rafId = null;
  function stopWatching() {
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    if (rafId && typeof root.cancelAnimationFrame === "function") {
      root.cancelAnimationFrame(rafId);
    }
    rafId = null;
  }
  function watchInjection() {
    if (nativeBridge()) {
      markReady();
      return;
    }
    var frames = 0;
    var tick = function () {
      if (nativeBridge()) {
        stopWatching();
        markReady();
        return true;
      }
      return false;
    };
    if (typeof root.requestAnimationFrame === "function") {
      (function raf() {
        if (bridgeReady || ++frames > 10) return; // ~first 10 frames only
        if (tick()) return;
        rafId = root.requestAnimationFrame(raf);
      })();
    }
    if (bridgeReady) return;
    var tries = 0;
    watchTimer = setInterval(function () {
      tries++;
      if (tick()) return;
      if (tries > 100) {
        stopWatching();
        console.warn("[nexajs.bridge] native bridge never injected - check that Java calls window.nexaBridgeReady() after executeScript().");
      }
    }, 50);
  }
  watchInjection();

  var bridge = {
    get isReady() {
      return bridgeReady;
    },

    /** Callback API - always available; queues until Java injects the bridge. */
    call: function (method, args, callback) {
      var nb = nativeBridge();
      if (!nb) {
        pendingQueue.push({ method: method, args: args, callback: callback });
        return null;
      }
      var cb = function (raw) {
        var payload;
        try {
          payload = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch (e) {
          payload = { ok: false, error: "Malformed bridge response: " + e.message };
        }
        if (!callback) {
          if (payload && payload.ok === false) {
            console.error("[nexajs.bridge] " + method + ": " + payload.error);
          }
          return;
        }
        if (payload && payload.ok) callback(null, payload.result);
        else {
          var err = new Error((payload && payload.error) || "Unknown bridge error");
          err.payload = payload; // keep full envelope (e.g. accounting error codes)
          callback(err);
        }
      };
      try {
        nb.invoke(method, JSON.stringify(args === undefined ? {} : args), cb);
      } catch (e) {
        if (callback) callback(e);
      }
      return null;
    },

    /** Promise API - wraps the callback API. Rejects after opts.timeoutMs
     *  (default 10s) so queued/never-answered calls cannot hang forever. */
    invoke: function (method, args, opts) {
      var timeoutMs = (opts && opts.timeoutMs != null) ? opts.timeoutMs : DEFAULT_CALL_TIMEOUT_MS;
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = null;
        if (timeoutMs > 0) {
          timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            var err = new Error("Bridge call '" + method + "' timed out after " + timeoutMs + "ms");
            err.code = "BRIDGE_TIMEOUT";
            reject(err);
          }, timeoutMs);
        }
        bridge.call(method, args, function (err, result) {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (err) reject(err);
          else resolve(result);
        });
      });
    },

    onReady: function (cb) {
      if (bridgeReady) {
        setTimeout(cb, 0);
      } else {
        readyCallbacks.push(cb);
      }
    }
  };
  Nexa.bridge = bridge;

  // ============================================================
  // 4 & 5. MODIFIERS (require hooks in the core; degrade gracefully)
  // ============================================================
  if (typeof Nexa.registerModelModifier === "function") {
    Nexa.registerModelModifier("number", {
      read: function (val) {
        var n = parseFloat(val);
        return isNaN(n) ? val : n;
      }
    });
    Nexa.registerModelModifier("trim", {
      read: function (val) {
        return typeof val === "string" ? val.trim() : val;
      }
    });
    Nexa.registerModelModifier("upper", {
      read: function (val) {
        return typeof val === "string" ? val.toUpperCase() : val;
      }
    });
    Nexa.registerModelModifier("cents", {
      // Accounting helper: input in cents units ("1250" -> 12.50)
      read: function (val) {
        var n = parseFloat(val);
        return isNaN(n) ? val : n / 100;
      },
      write: function (val) {
        var n = parseFloat(val);
        return isNaN(n) ? val : String(Math.round(n * 100));
      }
    });
  } else {
    console.warn("[nexajs.webview] core lacks registerModelModifier - .number/.trim disabled");
  }

  if (typeof Nexa.registerEventModifier === "function") {
    Nexa.registerEventModifier("debounce", function (next, el, ctx, opts) {
      var ms = (opts && opts.debounceMs) || 250;
      var timer = null;
      return function (e) {
        clearTimeout(timer);
        var ev = e;
        timer = setTimeout(function () {
          next(ev);
        }, ms);
      };
    });
    Nexa.registerEventModifier("throttle", function (next, el, ctx, opts) {
      var ms = (opts && opts.throttleMs) || 250;
      var last = 0;
      var timer = null;
      return function (e) {
        var now = Date.now();
        var remaining = ms - (now - last);
        if (remaining <= 0) {
          last = now;
          next(e);
        } else if (!timer) {
          var ev = e;
          timer = setTimeout(function () {
            timer = null;
            last = Date.now();
            next(ev);
          }, remaining);
        }
      };
    });
  } else {
    console.warn("[nexajs.webview] core lacks registerEventModifier - .debounce/.throttle disabled");
  }

  // ============================================================
  // 6. DATA FORMATTING (Nexa.format / $format)
  // ============================================================
  // Defaults: navigator.language wins when present; "es-MX"/"MXN" is only the
  // last-resort fallback. Override at runtime with Nexa.format.setLocale("es-CU")
  // / setCurrency("CUP") (or $format.setLocale(...) inside templates).
  var locale = (root.navigator && root.navigator.language) || "es-MX";
  // Currency follows the locale region when detectable (es-CU->CUP, es-ES->EUR,
  // en-US->USD); explicit setCurrency() always wins. "MXN" is the last-resort
  // default only when no locale/region can be detected at all.
  function currencyForLocale(loc) {
    var m = /[-_]([A-Za-z]{2})(?:[-_]|$)/.exec(loc || "");
    var region = m ? m[1].toUpperCase() : "";
    var map = { CU: "CUP", ES: "EUR", MX: "MXN", US: "USD", CA: "CAD", GB: "GBP",
                DE: "EUR", FR: "EUR", IT: "EUR", PT: "EUR", BR: "BRL", JP: "JPY",
                CN: "CNY", AU: "AUD", CO: "COP", AR: "ARS", VE: "USD" };
    return map[region] || null;
  }
  var currencyCode = currencyForLocale(locale) || "MXN";
  var explicitCurrency = false; // setCurrency() pins the code against locale changes

  var intlNumberOk = (function () {
    try { return new Intl.NumberFormat(locale).format(1) === "1"; } catch (e) { return false; }
  })();

  function probeSeparators(fmt) {
    var s = fmt.format(1234567.89);
    var thousands = ",";
    var decimal = ".";
    var m = s.match(/^1(.)234/);
    if (m) thousands = m[1];
    var d = s.match(/7(.)89$/);
    if (d) decimal = d[1];
    return { thousands: thousands, decimal: decimal };
  }

  // Locale-aware separators for the no-Intl fallback path (issue #6):
  // 1st choice: Intl itself; 2nd: Java bridge ($env hint or storage-style RPC);
  // last resort: US convention.
  function localeSeparators() {
    try {
      if (intlNumberOk) return probeSeparators(new Intl.NumberFormat(locale));
    } catch (e) {}
    try {
      var hints = root.__nexaEnvHints; // optional JSON injected by Java alongside nexaNative
      if (hints) {
        if (typeof hints === "string") hints = JSON.parse(hints);
        if (hints.thousandsSeparator && hints.decimalSeparator)
          return { thousands: hints.thousandsSeparator, decimal: hints.decimalSeparator };
      }
    } catch (e) {}
    return { thousands: ",", decimal: "." };
  }

  function manualGrouping(numStr, thousandsSep, decimalSep, decimals) {
    var parts = numStr.split(".");
    var intPart = parts[0];
    var frac = parts[1] || "";
    if (decimals >= 0) {
      frac = (frac + "000000").slice(0, decimals);
      if (decimals === 0) frac = "";
    }
    var sign = intPart.charAt(0) === "-" ? "-" : "";
    intPart = intPart.replace("-", "");
    var grouped = "";
    var count = 0;
    for (var i = intPart.length - 1; i >= 0; i--) {
      grouped = intPart.charAt(i) + grouped;
      if (++count % 3 === 0 && i > 0) grouped = thousandsSep + grouped;
    }
    return sign + grouped + (frac ? decimalSep + frac : "");
  }

  var format = {
    setLocale: function (l) {
      var prev = locale;
      locale = l || locale;
      // When the locale changes and no explicit currency was set, follow the
      // new locale's region automatically (es-CU -> CUP, es-ES -> EUR, ...).
      if (l && l !== prev && !explicitCurrency) currencyCode = currencyForLocale(locale) || currencyCode;
    },
    setCurrency: function (c) {
      if (c) explicitCurrency = true;
      currencyCode = c || currencyCode;
    },

    number: function (value, decimals) {
      var n = Number(value);
      if (!isFinite(n)) return "";
      try {
        return new Intl.NumberFormat(locale, {
          minimumFractionDigits: decimals == null ? 2 : decimals,
          maximumFractionDigits: decimals == null ? 2 : decimals
        }).format(n);
      } catch (e) {
        // Fallback respects the locale's own separators (issue #6).
        var sep = localeSeparators();
        return manualGrouping(String(n.toFixed(decimals == null ? 2 : decimals)), sep.thousands, sep.decimal, -1);
      }
    },

    currency: function (value, code) {
      var n = Number(value);
      if (!isFinite(n)) return "";
      var cur = code || currencyCode;
      try {
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency: cur,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(n);
      } catch (e) {
        return cur + " " + format.number(n, 2);
      }
    },

    percent: function (value, decimals) {
      var n = Number(value);
      if (!isFinite(n)) return "";
      try {
        return new Intl.NumberFormat(locale, {
          style: "percent",
          minimumFractionDigits: decimals == null ? 1 : decimals,
          maximumFractionDigits: decimals == null ? 1 : decimals
        }).format(n);
      } catch (e) {
        return format.number(n * 100, decimals == null ? 1 : decimals) + "%";
      }
    },

    /** date(value[, pattern]) - pattern supports dd/mm/yyyy/yy/hh/MM/SS tokens.
     *  Without a pattern it uses the locale default (Intl.DateTimeFormat). */
    date: function (value, pattern) {
      var d = value instanceof Date ? value : new Date(value);
      if (isNaN(d.getTime())) return "";
      if (pattern) return applyDatePattern(d, pattern);
      try {
        return new Intl.DateTimeFormat(locale).format(d);
      } catch (e) {
        return pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear();
      }
    },

    datetime: function (value, pattern) {
      var d = value instanceof Date ? value : new Date(value);
      if (isNaN(d.getTime())) return "";
      if (pattern) return applyDatePattern(d, pattern);
      try {
        return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
      } catch (e) {
        return applyDatePattern(d, "dd/mm/yyyy hh:MM");
      }
    }
  };

  function pad2(v) {
    v = String(v);
    return v.length < 2 ? "0" + v : v;
  }
  function applyDatePattern(d, pattern) {
    var map = {
      yyyy: String(d.getFullYear()),
      yy: pad2(d.getFullYear() % 100),
      mm: pad2(d.getMonth() + 1), // month number (accounting convention)
      dd: pad2(d.getDate()),
      hh: pad2(d.getHours()),
      MM: pad2(d.getMinutes()),
      SS: pad2(d.getSeconds())
    };
    return pattern.replace(/yyyy|yy|mm|dd|hh|MM|SS/g, function (t) {
      return map[t];
    });
  }

  Nexa.format = format;

  // ============================================================
  // 7. LOCAL PERSISTENCE (Nexa.storage / $storage)
  // ============================================================
  var localOk = (function () {
    try {
      var k = "__nexa_probe__";
      root.localStorage.setItem(k, "1");
      root.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false; // file:// can fail silently in WebKit
    }
  })();

  function readLocal(key) {
    if (!localOk) return null;
    try {
      return root.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function writeLocal(key, value) {
    if (!localOk) return false;
    try {
      root.localStorage.setItem(key, String(value));
      return true;
    } catch (e) {
      return false;
    }
  }
  function deleteLocal(key) {
    if (!localOk) return false;
    try {
      root.localStorage.removeItem(key);
      return true;
    } catch (e) {
      return false;
    }
  }

  var storage = {
    get isLocalAvailable() {
      return localOk;
    },
    // Clean primary API: get/set/remove (+ async Java-backed variants).
    get: function (key) {
      return readLocal(key);
    },
    set: function (key, value) {
      return writeLocal(key, value);
    },
    remove: function (key) {
      return deleteLocal(key);
    },
    // Deprecated localStorage-style aliases (kept for compatibility).
    getItem: readLocal,
    setItem: writeLocal,
    removeItem: deleteLocal,
    // Async Java-backed variants (work regardless of localOk)
    setAsync: function (key, value) {
      return bridge.invoke("storage.set", { key: key, value: String(value) });
    },
    getAsync: function (key) {
      return bridge.invoke("storage.get", { key: key });
    },
    removeAsync: function (key) {
      return bridge.invoke("storage.remove", { key: key });
    }
  };
  Nexa.storage = storage;

  // ============================================================
  // 8. ORDERED BOOT (Nexa.ready)
  // ============================================================
  function domReady() {
    return new Promise(function (resolve) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  function bridgeReadyP() {
    return new Promise(function (resolve) {
      if (bridge.isReady) return resolve(true);
      var done = false;
      bridge.onReady(function () {
        if (!done) {
          done = true;
          resolve(true);
        }
      });
      // Never block startup forever: proceed without bridge after 1s.
      // (With the recommended nexaBridgeReady() notification this resolves
      // almost immediately; the timeout only guards broken JVM wiring.)
      setTimeout(function () {
        if (!done) {
          done = true;
          resolve(false);
        }
      }, 1000);
    });
  }

  Nexa.ready = function (callback) {
    return domReady()
      .then(bridgeReadyP)
      .then(function (hadBridge) {
        return callback(hadBridge);
      });
  };

  // Auto-boot: whenever nobody called start yet and any directive is present.
  // Dynamic shorthands (@click, :href) are not valid CSS attribute names, so we
  // scan attributes manually instead of relying on exotic selector syntax.
  function hasNexaMarkup(doc) {
    var DIRECTIVES = ["x-data","x-if","x-for","x-model","x-init","x-text","x-show",
      "x-bind","x-html","x-ref","x-persist","x-component","x-effect","x-cloak","x-on"];
    var nodes = doc.querySelectorAll("*");
    for (var i = 0; i < nodes.length; i++) {
      var attrs = nodes[i].attributes;
      if (!attrs) continue;
      for (var j = 0; j < attrs.length; j++) {
        var n = attrs[j].name;
        if (n.charAt(0) === "@" || n.charAt(0) === ":") return true; // shorthand directives
        for (var k = 0; k < DIRECTIVES.length; k++) {
          if (n === DIRECTIVES[k] || n.indexOf(DIRECTIVES[k] + ".") === 0) return true;
        }
      }
    }
    return false;
  }

  Nexa.ready(function () {
    if (!Nexa._webviewStarted && hasNexaMarkup(document)) {
      Nexa.start();
    }
  });

  // ============================================================
  // 9. CENTRALIZED ERROR HANDLING (Nexa.errorHandler)
  // ============================================================
  function reportError(payload) {
    console.error("[nexajs.error]", payload.message, payload.stack || "");
    if (bridge.isReady) {
      bridge.call("log.error", payload, null);
    }
  }

  root.addEventListener("error", function (e) {
    reportError({
      type: "window.onerror",
      message: e.message || "Unknown error",
      stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 4000) : null,
      source: e.filename,
      line: e.lineno,
      column: e.colno,
      timestamp: new Date().toISOString(),
      userAgent: ua
    });
  });

  root.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    reportError({
      type: "unhandledrejection",
      message: (r && r.message) || String(r),
      stack: r && r.stack ? String(r.stack).slice(0, 4000) : null,
      timestamp: new Date().toISOString(),
      userAgent: ua
    });
  });

  Nexa.errorHandler = { report: reportError };

  // ============================================================
  // 10. START INTEGRATION (wrapper around Nexa.start)
  // ============================================================
  var originalStart = Nexa.start;
  Nexa.start = function (selector, extraScope) {
    var rootHelpers = {
      $bridge: bridge,
      $format: format,
      $storage: storage,
      $env: env
    };
    Nexa._webviewStarted = true;
    return originalStart.call(Nexa, selector, assign({}, rootHelpers, extraScope || {}));
  };
})(typeof window !== "undefined" ? window : this);
