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

  var Nexa = global.Nexa;
  if (!Nexa) {
    console.warn(
      "[nexajs.webview] window.Nexa not found - load nexajs.js (core) BEFORE this extension.",
    );
    return;
  }

  // ============================================================
  // 1. ENVIRONMENT DETECTION (Nexa.env)
  // ============================================================
  var ua = (global.navigator && global.navigator.userAgent) || "";
  var fxMatch = ua.match(/JavaFX[\/ ]?(\d+(?:\.\d+)?)/i);
  var safariMatch = ua.match(/Version\/(\d+(?:\.\d+)?).*Safari/i);

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
    webkitVersion: null, // filled from Java bridge when available
    safariEquivalent: safariMatch ? safariMatch[1] : null,
    capabilities: {
      proxy: probe(function () {
        return new Proxy({}, {}) instanceof Object;
      }),
      promise: typeof Promise === "function",
      asyncAwait: probe(function () {
        return new Function("return (async function(){})()")() instanceof Promise;
      }),
      setImmediate: typeof global.setImmediate === "function",
      mutationObserver: typeof global.MutationObserver === "function",
      intersectionObserver: typeof global.IntersectionObserver === "function",
      resizeObserver: typeof global.ResizeObserver === "function",
      customElements: probe(function () {
        return !!(global.customElements && global.customElements.define);
      }),
      fetch: typeof global.fetch === "function",
      intl: typeof global.Intl !== "undefined" && !!global.Intl.NumberFormat,
      esmExecution: false, // probe-verified: WebEngine does NOT run module scripts
    },
  };
  Nexa.env = env;

  // ============================================================
  // 2. POLYFILLS (install only what the probe says is missing)
  // ============================================================
  if (!env.capabilities.setImmediate) {
    global.setImmediate = function (fn) {
      var args = Array.prototype.slice.call(arguments, 1);
      return setTimeout.apply(global, [fn, 0].concat(args));
    };
    global.clearImmediate = function (id) {
      clearTimeout(id);
    };
  }

  if (typeof global.queueMicrotask !== "function") {
    global.queueMicrotask = function (fn) {
      Promise.resolve()
        .then(fn)
        .catch(function (err) {
          setTimeout(function () {
            throw err;
          }, 0);
        });
    };
  }

  if (typeof global.requestIdleCallback !== "function") {
    global.requestIdleCallback = function (cb) {
      var start = Date.now();
      return setTimeout(function () {
        cb({
          didTimeout: false,
          timeRemaining: function () {
            return Math.max(0, 50 - (Date.now() - start));
          },
        });
      }, 1);
    };
    global.cancelIdleCallback = function (id) {
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
  var pendingQueue = []; // calls made before injection
  var readyCallbacks = [];
  var bridgeReady = false;

  function nativeBridge() {
    return global.nexaNative || null;
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

  // Poll briefly for injection (WebEngine.executeScript of the bridge object
  // usually lands within the first animation frames after document load).
  function watchInjection() {
    if (nativeBridge()) {
      markReady();
      return;
    }
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (nativeBridge()) {
        clearInterval(t);
        markReady();
      } else if (tries > 100) {
        clearInterval(t); // 5s grace, then degrade silently
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
        else callback(new Error((payload && payload.error) || "Unknown bridge error"));
      };
      try {
        nb.invoke(method, JSON.stringify(args === undefined ? {} : args), cb);
      } catch (e) {
        if (callback) callback(e);
      }
      return null;
    },

    /** Promise API - wraps the callback API. */
    invoke: function (method, args) {
      return new Promise(function (resolve, reject) {
        bridge.call(method, args, function (err, result) {
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
    },
  };
  Nexa.bridge = bridge;

  // ============================================================
  // 4 & 5. MODIFIERS (require hooks in the core; degrade gracefully)
  // ============================================================
  if (typeof Nexa.registerModelModifier === "function") {
    Nexa.registerModelModifier("number", {
      read: function (val) {
        var n = parseFloat(val);
        return Number.isNaN(n) ? val : n;
      },
    });
    Nexa.registerModelModifier("trim", {
      read: function (val) {
        return typeof val === "string" ? val.trim() : val;
      },
    });
    Nexa.registerModelModifier("upper", {
      read: function (val) {
        return typeof val === "string" ? val.toUpperCase() : val;
      },
    });
    Nexa.registerModelModifier("cents", {
      // Accounting helper: input in cents units ("1250" -> 12.50)
      read: function (val) {
        var n = parseFloat(val);
        return Number.isNaN(n) ? val : n / 100;
      },
      write: function (val) {
        var n = parseFloat(val);
        return Number.isNaN(n) ? val : String(Math.round(n * 100));
      },
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
  var locale = (global.navigator && global.navigator.language) || "es-MX";
  var currencyCode = "MXN";

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
      locale = l || locale;
    },
    setCurrency: function (c) {
      currencyCode = c || currencyCode;
    },

    number: function (value, decimals) {
      var n = Number(value);
      if (!isFinite(n)) return "";
      try {
        return new Intl.NumberFormat(locale, {
          minimumFractionDigits: decimals == null ? 2 : decimals,
          maximumFractionDigits: decimals == null ? 2 : decimals,
        }).format(n);
      } catch (e) {
        return manualGrouping(String(n.toFixed(decimals == null ? 2 : decimals)), ",", ".", -1);
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
          maximumFractionDigits: 2,
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
          maximumFractionDigits: decimals == null ? 1 : decimals,
        }).format(n);
      } catch (e) {
        return format.number(n * 100, decimals == null ? 1 : decimals) + "%";
      }
    },

    date: function (value) {
      var d = value instanceof Date ? value : new Date(value);
      if (isNaN(d.getTime())) return "";
      try {
        return new Intl.DateTimeFormat(locale).format(d);
      } catch (e) {
        return d.toISOString().slice(0, 10);
      }
    },

    datetime: function (value) {
      var d = value instanceof Date ? value : new Date(value);
      if (isNaN(d.getTime())) return "";
      try {
        return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
      } catch (e) {
        return d.toISOString().replace("T", " ").slice(0, 16);
      }
    },
  };
  Nexa.format = format;

  // ============================================================
  // 7. LOCAL PERSISTENCE (Nexa.storage / $storage)
  // ============================================================
  var localOk = (function () {
    try {
      var k = "__nexa_probe__";
      global.localStorage.setItem(k, "1");
      global.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false; // file:// can fail silently in WebKit
    }
  })();

  var storage = {
    get isLocalAvailable() {
      return localOk;
    },
    getItem: function (key) {
      if (!localOk) return null;
      try {
        return global.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    setItem: function (key, value) {
      if (!localOk) return false;
      try {
        global.localStorage.setItem(key, String(value));
        return true;
      } catch (e) {
        return false;
      }
    },
    removeItem: function (key) {
      if (!localOk) return false;
      try {
        global.localStorage.removeItem(key);
        return true;
      } catch (e) {
        return false;
      }
    },
    // Async Java-backed variants (work regardless of localOk)
    setAsync: function (key, value) {
      return bridge.invoke("storage.set", { key: key, value: String(value) });
    },
    getAsync: function (key) {
      return bridge.invoke("storage.get", { key: key });
    },
    removeAsync: function (key) {
      return bridge.invoke("storage.remove", { key: key });
    },
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
      // Never block startup forever: proceed without bridge after 3s.
      setTimeout(function () {
        if (!done) {
          done = true;
          resolve(false);
        }
      }, 3000);
    });
  }

  Nexa.ready = function (callback) {
    return domReady()
      .then(bridgeReadyP)
      .then(function (hadBridge) {
        return callback(hadBridge);
      });
  };

  // Auto-boot: if directives exist in the DOM and nobody called start yet.
  Nexa.ready(function () {
    var hasDirectives = document.querySelector("[x-data],[x-if],[x-for],[x-model],[x-init],[x-text],[x-show],[x-bind]");
    if (hasDirectives && !Nexa._started) {
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

  global.addEventListener("error", function (e) {
    reportError({
      type: "window.onerror",
      message: e.message || "Unknown error",
      stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 4000) : null,
      source: e.filename,
      line: e.lineno,
      column: e.colno,
      timestamp: new Date().toISOString(),
      userAgent: ua,
    });
  });

  global.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    reportError({
      type: "unhandledrejection",
      message: (r && r.message) || String(r),
      stack: r && r.stack ? String(r.stack).slice(0, 4000) : null,
      timestamp: new Date().toISOString(),
      userAgent: ua,
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
      $env: env,
    };
    Nexa._started = true;
    return originalStart.call(Nexa, selector, Object.assign({}, rootHelpers, extraScope || {}));
  };
})(window);
