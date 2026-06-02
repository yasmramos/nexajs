/**
 * NexaJS v0.5.0 - A lightweight reactive framework without build steps
 * Author: Yasmany Ramos García
 * License: Apache 2.0
 */

(function () {
  "use strict";

  // ============================================
  // 1. CORE REACTIVITY SYSTEM WITH SCHEDULER
  // ============================================

  const queue = new Set();
  let isFlushing = false;
  let activeEffect = null;
  const effectStack = [];
  const targetMap = new WeakMap();

  // Cache for reactive objects to avoid recreating proxies
  const reactiveCache = new WeakMap();

  // Error handling utility
  function handleError(error, context = '') {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`NexaJS Error${context ? ` in ${context}` : ''}:`, errorMessage);
    
    // Trigger global error event for custom handling
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('nexajs:error', { 
        detail: { error, context } 
      }));
    }
    
    return error;
  }

  // Scheduler: Batch updates using microtasks
  function scheduleEffect(effect) {
    if (effect.disabled) return;
    queue.add(effect);
    if (!isFlushing) {
      isFlushing = true;
      Promise.resolve().then(flushQueue).catch(err => handleError(err, 'scheduler'));
    }
  }

  function flushQueue() {
    try {
      queue.forEach((effect) => {
        if (!effect.disabled) {
          try {
            effect();
          } catch (e) {
            handleError(e, 'effect execution');
          }
        }
      });
    } finally {
      queue.clear();
      isFlushing = false;
    }
  }

  // Dependency tracking
  function track(target, key) {
    if (!activeEffect) return;

    let depsMap = targetMap.get(target);
    if (!depsMap) {
      depsMap = new Map();
      targetMap.set(target, depsMap);
    }

    let dep = depsMap.get(key);
    if (!dep) {
      dep = new Set();
      depsMap.set(key, dep);
    }

    if (!dep.has(activeEffect)) {
      dep.add(activeEffect);
      if (!activeEffect.deps) activeEffect.deps = [];
      activeEffect.deps.push(dep);
    }
  }

  function trigger(target, key) {
    const depsMap = targetMap.get(target);
    if (!depsMap) return;

    const dep = depsMap.get(key);
    if (dep) {
      dep.forEach((effect) => {
        if (effect !== activeEffect && !effect.disabled) {
          scheduleEffect(effect);
        }
      });
    }
  }

  function reactive(obj, componentName = "") {
    // Return cached reactive if it exists
    if (reactiveCache.has(obj)) {
      return reactiveCache.get(obj);
    }

    try {
      const proxy = new Proxy(obj, {
        get(target, key, receiver) {
          track(target, key);
          const result = Reflect.get(target, key, receiver);
          if (
            typeof result === "object" &&
            result !== null &&
            !result.__isReactive
          ) {
            // Check cache first before creating new proxy
            if (reactiveCache.has(result)) {
              return reactiveCache.get(result);
            }
            const nestedProxy = reactive(result, componentName);
            reactiveCache.set(result, nestedProxy);
            return nestedProxy;
          }
          return result;
        },
        set(target, key, value, receiver) {
          try {
            const oldValue = target[key];
            if (oldValue === value) return true;

            target[key] = value;
            trigger(target, key);
            return true;
          } catch (e) {
            handleError(e, `reactive.set (${componentName || 'global'}.${String(key)})`);
            return false;
          }
        },
        deleteProperty(target, key) {
          try {
            const hadKey = Object.prototype.hasOwnProperty.call(target, key);
            delete target[key];
            if (hadKey) trigger(target, key);
            return true;
          } catch (e) {
            handleError(e, `reactive.deleteProperty (${componentName || 'global'}.${String(key)})`);
            return false;
          }
        },
      });

      proxy.__isReactive = true;
      reactiveCache.set(obj, proxy);
      return proxy;
    } catch (e) {
      handleError(e, `reactive (${componentName || 'global'})`);
      // Fallback: return original object with minimal reactivity
      return obj;
    }
  }

  // Computed properties with improved error handling
  function computed(getterFn) {
    if (typeof getterFn !== 'function') {
      handleError(new Error('computed() requires a function'), 'computed');
      return { value: undefined };
    }

    const result = { value: undefined };
    let dirty = true;
    let runner = null;

    const evaluateComputed = () => {
      try {
        result.value = getterFn();
        dirty = false;
      } catch (e) {
        handleError(e, 'computed evaluation');
        dirty = true;
      }
    };

    runner = effect(() => {
      evaluateComputed();
    });

    // Override the effect to mark as dirty when dependencies change
    const originalDeps = runner.deps || [];

    return {
      get value() {
        if (dirty) {
          evaluateComputed();
        }
        // Track the computed itself as a dependency
        if (activeEffect) {
          track(result, 'value');
        }
        return result.value;
      },
      _runner: runner,
    };
  }

  // Watcher system with improved error handling
  function watch(sourceFnOrExpr, callback, options = {}) {
    if (typeof sourceFnOrExpr !== 'function') {
      handleError(new Error('watch() requires a function as first argument'), 'watch');
      return { stop: () => {} };
    }
    
    if (typeof callback !== 'function') {
      handleError(new Error('watch() requires a callback function'), 'watch');
      return { stop: () => {} };
    }

    const immediate = options.immediate || false;
    const deep = options.deep || false;

    let oldValue = undefined;

    const watcher = () => {
      try {
        const newValue = sourceFnOrExpr();

        if (immediate && oldValue === undefined) {
          callback(newValue, undefined);
        } else if (newValue !== oldValue) {
          callback(newValue, oldValue);
        }

        oldValue = newValue;
      } catch (e) {
        handleError(e, 'watch callback');
      }
    };

    const runner = effect(watcher);

    if (immediate) {
      // Trigger immediately
      try {
        watcher();
      } catch (e) {
        handleError(e, 'watch immediate callback');
      }
    }

    return runner;
  }

  function effect(fn) {
    if (typeof fn !== 'function') {
      handleError(new Error('effect() requires a function'), 'effect');
      const dummyRunner = () => {};
      dummyRunner.deps = [];
      dummyRunner.cleanupFns = [];
      dummyRunner.disabled = true;
      dummyRunner.stop = () => {};
      return dummyRunner;
    }

    const runner = () => {
      // Cleanup previous dependencies
      if (runner.deps) {
        runner.deps.forEach((dep) => dep.delete(runner));
        runner.deps = [];
      }

      // Execute cleanup callbacks if they exist
      if (runner.cleanupFns) {
        runner.cleanupFns.forEach((fn) => {
          try {
            fn();
          } catch (e) {
            handleError(e, 'effect cleanup');
          }
        });
        runner.cleanupFns = [];
      }

      activeEffect = runner;
      effectStack.push(runner);

      try {
        return fn();
      } catch (e) {
        handleError(e, 'effect execution');
        throw e; // Re-throw to allow caller to handle
      } finally {
        effectStack.pop();
        activeEffect =
          effectStack.length > 0 ? effectStack[effectStack.length - 1] : null;
      }
    };

    runner.deps = [];
    runner.cleanupFns = [];
    runner.disabled = false;

    // Method to stop the effect
    runner.stop = () => {
      runner.disabled = true;
      if (runner.deps) {
        runner.deps.forEach((dep) => dep.delete(runner));
      }
      if (runner.cleanupFns) {
        runner.cleanupFns.forEach((fn) => {
          try {
            fn();
          } catch (e) {
            handleError(e, 'effect stop cleanup');
          }
        });
      }
    };

    try {
      runner();
    } catch (e) {
      // Error already handled in runner
    }
    return runner;
  }

  // ============================================
  // 2. SAFE EXPRESSION EVALUATOR WITH CACHE
  // ============================================

  const expressionCache = new Map();

  function compileExpression(expr) {
    if (expressionCache.has(expr)) {
      return expressionCache.get(expr);
    }

    try {
      // Create a safe function without 'with' statement
      const fn = new Function(
        "scope",
        `
        try {
          ${Object.keys(scope)
            .map((key) => `const ${key} = scope.${key};`)
            .join("\n")}
          return ${expr};
        } catch(e) {
          console.warn('NexaJS Expression Error:', e.message, 'Expression:', expr);
          return undefined;
        }
      `,
      );

      expressionCache.set(expr, fn);
      return fn;
    } catch (e) {
      console.error("NexaJS: Invalid expression syntax", expr, e);
      return () => undefined;
    }
  }

  function evaluate(expr, scope) {
    if (!expr || typeof expr !== "string") return expr;
    const fn = compileExpression(expr);
    return fn(scope);
  }

  // ============================================
  // 3. DOM UTILITIES & CLEANUP SYSTEM
  // ============================================

  const nodeStore = new WeakMap();

  function getNodeEffects(node) {
    if (!nodeStore.has(node)) {
      nodeStore.set(node, { effects: [], cleanups: [] });
    }
    return nodeStore.get(node);
  }

  function addEffectToNode(node, effectRunner) {
    const store = getNodeEffects(node);
    store.effects.push(effectRunner);
  }

  function addCleanupToNode(node, fn) {
    const store = getNodeEffects(node);
    store.cleanups.push(fn);
  }

  function destroyNode(node) {
    if (!node) return;

    const store = nodeStore.get(node);
    if (store) {
      // Stop all effects
      store.effects.forEach((effect) => {
        if (effect.stop) effect.stop();
      });

      // Run all cleanup functions
      store.cleanups.forEach((fn) => {
        try {
          fn();
        } catch (e) {
          console.error("Cleanup error:", e);
        }
      });

      nodeStore.delete(node);
    }

    // Recursively destroy children
    if (node.nodeType === 1) {
      // Element node
      Array.from(node.children).forEach(destroyNode);
    }
  }

  // ============================================
  // 4. DIRECTIVES SYSTEM
  // ============================================

  const directives = {};

  function registerDirective(name, handler) {
    directives[name] = handler;
  }

  // x-cloak - Remove cloaked elements once compiled
  registerDirective("cloak", (el, expr, ctx, scopeNode) => {
    el.removeAttribute("x-cloak");
    el.style.display = "";
  });

  // x-text
  registerDirective("text", (el, expr, ctx, scopeNode) => {
    const update = () => {
      el.textContent = evaluate(expr, ctx) ?? "";
    };
    const runner = effect(update);
    addEffectToNode(scopeNode, runner);
  });

  // x-html
  registerDirective("html", (el, expr, ctx, scopeNode) => {
    const update = () => {
      el.innerHTML = evaluate(expr, ctx) ?? "";
    };
    const runner = effect(update);
    addEffectToNode(scopeNode, runner);
  });

  // x-show - Enhanced with transition support
  registerDirective("show", (el, expr, ctx, scopeNode) => {
    const originalDisplay = el.style.display || "";
    let isShown = false;
    
    const update = () => {
      const show = !!evaluate(expr, ctx);
      
      if (show === isShown) return;
      isShown = show;
      
      // Check for transition support
      const hasTransition = el._transition && typeof el._transition === 'object';
      
      if (show) {
        // Show element
        if (hasTransition) {
          const t = el._transition;
          t.beforeEnter();
          el.style.display = originalDisplay;
          t.enter();
          t.afterEnter();
        } else {
          el.style.display = originalDisplay;
        }
      } else {
        // Hide element
        if (hasTransition) {
          const t = el._transition;
          t.beforeLeave();
          t.leave();
          t.afterLeave();
          // Actually hide after transition completes
          setTimeout(() => {
            el.style.display = "none";
          }, 300);
        } else {
          el.style.display = "none";
        }
      }
    };
    
    const runner = effect(update);
    addEffectToNode(scopeNode, runner);
  });

  // x-if - Enhanced with transition support
  registerDirective("if", (el, expr, ctx, scopeNode) => {
    const anchor = document.createComment("x-if");
    const parent = el.parentNode;
    parent.insertBefore(anchor, el);
    el.remove();

    let mounted = false;
    let instance = null;
    let isLeaving = false;

    const update = () => {
      const show = !!evaluate(expr, ctx);

      if (show === mounted && !isLeaving) return;

      if (show) {
        if (isLeaving && instance) {
          // Cancel leave transition
          isLeaving = false;
          return;
        }
        
        if (el.tagName === "TEMPLATE") {
          const content = el.content.cloneNode(true);
          parent.insertBefore(content, anchor);
          instance = content;

          // Check for transition on the first element
          const firstElement = content.querySelector?.('[x-transition]') || 
                              (content.nodeType === 1 ? content : null);
          
          // Compile the new content with the same context
          compile(instance, ctx);
          
          // Trigger enter transition if present
          if (firstElement && firstElement._transition) {
            const t = firstElement._transition;
            t.beforeEnter();
            t.enter();
            t.afterEnter();
          }
        }
        mounted = true;
      } else {
        if (instance) {
          // Check for transition
          const firstElement = instance.querySelector?.('[x-transition]') || 
                              (instance.nodeType === 1 ? instance : null);
          
          if (firstElement && firstElement._transition && !isLeaving) {
            // Start leave transition
            isLeaving = true;
            const t = firstElement._transition;
            t.beforeLeave();
            t.leave();
            t.afterLeave();
            
            // Actually remove after transition completes
            setTimeout(() => {
              if (instance) {
                destroyNode(instance);
                instance.remove();
                instance = null;
              }
              mounted = false;
              isLeaving = false;
            }, 300);
            return;
          } else {
            destroyNode(instance);
            instance.remove();
            instance = null;
          }
        }
        mounted = false;
        isLeaving = false;
      }
    };

    const runner = effect(update);
    addEffectToNode(anchor, runner);

    // Cleanup when anchor is destroyed
    addCleanupToNode(anchor, () => {
      if (instance) {
        destroyNode(instance);
        instance.remove();
      }
    });
  });

  // x-for (With Keyed Diffing Algorithm)
  registerDirective("for", (el, expr, ctx, scopeNode) => {
    const anchor = document.createComment("x-for");
    const parent = el.parentNode;
    parent.insertBefore(anchor, el);
    el.remove();

    // Parse expression: "item in list" or "(item, index) in list"
    const match = expr.match(/^(?:\(([^)]+)\)|(\w+))\s+(?:in|of)\s+(.+)$/);
    if (!match) {
      console.error("NexaJS: Invalid x-for expression:", expr);
      return;
    }

    const itemStr = match[1] || match[2];
    const listExpr = match[3].trim();

    // Check if we have (item, index) or just item
    const itemParts = itemStr.split(",").map((s) => s.trim());
    const itemName = itemParts[0];
    const indexName = itemParts[1];

    const nodeMap = new Map(); // key -> { node, effect }
    const keyAnchorMap = new Map(); // key -> anchor comment

    const update = () => {
      const list = evaluate(listExpr, ctx) || [];

      // Generate keys for each item
      const newItems = list.map((item, i) => {
        // Use item.id if available, otherwise use index
        const key =
          item && typeof item === "object" && "id" in item ? item.id : i;
        return { key, item, index: i };
      });

      const newKeys = newItems.map((x) => x.key);
      const oldKeys = Array.from(nodeMap.keys());

      // Step 1: Remove deleted items
      oldKeys.forEach((key) => {
        if (!newKeys.includes(key)) {
          const record = nodeMap.get(key);
          if (record) {
            destroyNode(record.node);
            record.node.remove();
            if (record.anchor) record.anchor.remove();
            nodeMap.delete(key);
            keyAnchorMap.delete(key);
          }
        }
      });

      // Step 2: Update existing and insert new items
      let currentAnchor = anchor;

      newItems.forEach(({ key, item, index }) => {
        const itemScope = { [itemName]: item };
        if (indexName) itemScope[indexName] = index;
        const mergedScope = { ...ctx, ...itemScope };

        if (nodeMap.has(key)) {
          // Update existing node
          const record = nodeMap.get(key);
          record.node._scope = mergedScope;

          // Move node if needed
          if (record.node.previousSibling !== currentAnchor) {
            const nextSibling = currentAnchor.nextSibling;
            // Move all nodes in the group
            let temp = record.anchor ? record.anchor.nextSibling : record.node;
            while (
              temp &&
              temp !==
              (nodeMap.get(newKeys[newKeys.indexOf(key) + 1])?.anchor ||
                  anchor)
            ) {
              const nextTemp = temp.nextSibling;
              parent.insertBefore(temp, nextSibling);
              temp = nextTemp;
            }
          }
          currentAnchor = record.anchor || record.node;
        } else {
          // Create new node
          const clone = el.content.cloneNode(true);
          const itemAnchor = document.createComment(`x-for-item-${key}`);

          parent.insertBefore(itemAnchor, currentAnchor.nextSibling);
          parent.insertBefore(clone, itemAnchor.nextSibling);

          // Find the last element in the cloned content
          let last = itemAnchor;
          let temp = itemAnchor.nextSibling;
          while (temp && temp !== anchor) {
            if (temp.nodeType === 1) {
              temp._scope = mergedScope;
              compile(temp, mergedScope);
              last = temp;
            }
            temp = temp.nextSibling;
          }

          nodeMap.set(key, { node: last, anchor: itemAnchor });
          keyAnchorMap.set(key, itemAnchor);
          currentAnchor = itemAnchor;
        }
      });
    };

    const runner = effect(update);
    addEffectToNode(anchor, runner);

    // Cleanup when anchor is destroyed
    addCleanupToNode(anchor, () => {
      nodeMap.forEach((record) => {
        destroyNode(record.node);
        record.node.remove();
        if (record.anchor) record.anchor.remove();
      });
      nodeMap.clear();
      keyAnchorMap.clear();
    });
  });

  // x-model
  registerDirective("model", (el, expr, ctx, scopeNode) => {
    const setVal = (val) => {
      const parts = expr.split(".");
      let obj = ctx;
      for (let i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]];
        if (!obj) return;
      }
      const lastPart = parts[parts.length - 1];
      if (obj && lastPart in obj) {
        obj[lastPart] = val;
      }
    };

    const getVal = () => evaluate(expr, ctx);

    const updateView = () => {
      const val = getVal();
      if (el.type === "checkbox") {
        el.checked = !!val;
      } else if (el.type === "radio") {
        el.checked = String(el.value) === String(val);
      } else if (el.type === "number") {
        el.value = val ?? "";
      } else {
        el.value = val ?? "";
      }
    };

    const updateModel = (e) => {
      let val;
      if (el.type === "checkbox") {
        val = el.checked;
      } else if (el.type === "number") {
        val = parseFloat(el.value) || (el.value === "" ? "" : NaN);
      } else {
        val = el.value;
      }
      setVal(val);
    };

    el.addEventListener("input", updateModel);
    if (el.type === "checkbox" || el.type === "radio") {
      el.addEventListener("change", updateModel);
    }

    const runner = effect(updateView);
    addEffectToNode(scopeNode, runner);

    // Cleanup event listeners
    addCleanupToNode(scopeNode, () => {
      el.removeEventListener("input", updateModel);
      el.removeEventListener("change", updateModel);
    });
  });

  // x-on / @ - Enhanced with modifiers support (.once, .capture, .self, .prevent, .stop)
  registerDirective("on", (el, expr, ctx, arg, scopeNode) => {
    // Parse event name and modifiers (e.g., "click.once.prevent")
    const parts = arg.split(".");
    const eventName = parts[0];
    const modifiers = parts.slice(1);

    const handlerFn = compileExpression(expr);

    const listener = (e) => {
      // Handle .self modifier
      if (modifiers.includes("self") && e.target !== el) return;

      // Handle .prevent modifier
      if (modifiers.includes("prevent")) e.preventDefault();

      // Handle .stop modifier
      if (modifiers.includes("stop")) e.stopPropagation();

      const eventScope = { ...ctx, $event: e };
      try {
        handlerFn(eventScope);
      } catch (err) {
        handleError(err, `event handler for ${eventName}`);
      }

      // Handle .once modifier - remove listener after first execution
      if (modifiers.includes("once")) {
        el.removeEventListener(eventName, listener, modifiers.includes("capture"));
      }
    };

    const useCapture = modifiers.includes("capture");
    el.addEventListener(eventName, listener, useCapture);

    addCleanupToNode(scopeNode, () => {
      el.removeEventListener(eventName, listener, useCapture);
    });
  });

  // x-bind / :
  registerDirective("bind", (el, expr, ctx, arg, scopeNode) => {
    const attr = arg;

    const update = () => {
      const val = evaluate(expr, ctx);

      if (attr === "class") {
        if (typeof val === "string") {
          el.className = val;
        } else if (typeof val === "object" && val !== null) {
          // Handle object syntax: { 'active': isActive, 'disabled': isDisabled }
          const classList = [];
          Object.entries(val).forEach(([className, condition]) => {
            if (condition) classList.push(className);
          });
          el.className = classList.join(" ");
        } else if (Array.isArray(val)) {
          el.className = val.filter(Boolean).join(" ");
        }
      } else if (attr === "style") {
        if (typeof val === "string") {
          el.style.cssText = val;
        } else if (typeof val === "object" && val !== null) {
          Object.assign(el.style, val);
        }
      } else if (attr === "hidden") {
        if (val) {
          el.setAttribute("hidden", "");
        } else {
          el.removeAttribute("hidden");
        }
      } else if (typeof val === "boolean") {
        if (val) {
          el.setAttribute(attr, "");
        } else {
          el.removeAttribute(attr);
        }
      } else if (val != null) {
        el.setAttribute(attr, val);
      } else {
        el.removeAttribute(attr);
      }
    };

    const runner = effect(update);
    addEffectToNode(scopeNode, runner);
  });

  // x-transition - Simple transition system for enter/leave animations
  registerDirective("transition", (el, expr, ctx, arg, scopeNode) => {
    const transitionName = arg || "fade";
    
    // Add transition classes
    el.classList.add(`${transitionName}-enter-active`);
    el.classList.add(`${transitionName}-leave-active`);
    
    // Store transition info for x-show/x-if to use
    el._transition = {
      name: transitionName,
      beforeEnter: () => {
        el.classList.add(`${transitionName}-enter-from`);
        el.classList.remove(`${transitionName}-enter-to`);
      },
      enter: () => {
        requestAnimationFrame(() => {
          el.classList.remove(`${transitionName}-enter-from`);
          el.classList.add(`${transitionName}-enter-to`);
        });
      },
      afterEnter: () => {
        setTimeout(() => {
          el.classList.remove(`${transitionName}-enter-active`);
          el.classList.remove(`${transitionName}-enter-to`);
        }, 300); // Default duration, can be customized via CSS
      },
      beforeLeave: () => {
        el.classList.add(`${transitionName}-leave-from`);
        el.classList.remove(`${transitionName}-leave-to`);
      },
      leave: () => {
        requestAnimationFrame(() => {
          el.classList.remove(`${transitionName}-leave-from`);
          el.classList.add(`${transitionName}-leave-to`);
        });
      },
      afterLeave: () => {
        setTimeout(() => {
          el.classList.remove(`${transitionName}-leave-active`);
          el.classList.remove(`${transitionName}-leave-to`);
        }, 300);
      }
    };
  });

  // ============================================
  // 5. COMPONENT SYSTEM WITH LIFECYCLE
  // ============================================

  const components = {};

  function defineComponent(name, definition) {
    if (!name || !definition) {
      console.error("NexaJS: Component must have a name and definition");
      return;
    }
    components[name] = definition;
  }

  function createComponentContext(def, propsData = {}, parentCtx = {}) {
    const { data = {}, methods = {}, props = [], onMounted, onUnmounted } = def;

    // Initialize props
    const propObj = {};
    if (props && Array.isArray(props)) {
      props.forEach((p) => {
        propObj[p] = propsData[p] !== undefined ? propsData[p] : null;
      });
    }

    // Merge data and props into reactive state
    const state = reactive({ ...data, ...propObj });

    // Bind methods to state
    const boundMethods = {};
    if (methods && typeof methods === "object") {
      Object.keys(methods).forEach((key) => {
        if (typeof methods[key] === "function") {
          boundMethods[key] = methods[key].bind(state);
        }
      });
    }

    // Create component context
    const ctx = { ...state, ...boundMethods };

    // Call onMounted after a microtask
    let mountTimeout = null;
    if (onMounted && typeof onMounted === "function") {
      mountTimeout = setTimeout(() => {
        try {
          onMounted.call(state);
        } catch (e) {
          console.error("NexaJS onMounted error:", e);
        }
      }, 0);
    }

    // Return cleanup function
    const cleanup = () => {
      if (mountTimeout) clearTimeout(mountTimeout);
      if (onUnmounted && typeof onUnmounted === "function") {
        try {
          onUnmounted.call(state);
        } catch (e) {
          console.error("NexaJS onUnmounted error:", e);
        }
      }
    };

    return { ctx, cleanup };
  }

  // ============================================
  // 6. COMPILER
  // ============================================

  function compile(root, context) {
    if (!root) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const nodesToProcess = [];

    while (walker.nextNode()) {
      nodesToProcess.push(walker.currentNode);
    }

    nodesToProcess.forEach((el) => {
      if (!el.getAttribute) return;

      // Handle components first
      const compName = el.getAttribute("x-component");
      if (compName && !el._processed) {
        const def = components[compName];
        if (def) {
          // Extract props from attributes
          const propsData = {};
          Array.from(el.attributes).forEach((attr) => {
            const name = attr.name;
            const value = attr.value;

            if (name.startsWith(":")) {
              const propName = name.slice(1);
              propsData[propName] = evaluate(value, context);
            } else if (!name.startsWith("x-") && name !== "x-component") {
              propsData[name] = value;
            }
          });

          // Create component context
          const { ctx: compCtx, cleanup } = createComponentContext(
            def,
            propsData,
            context,
          );

          // Store component info on element
          el._scope = { ...context, ...compCtx };
          el._cleanup = cleanup;
          addCleanupToNode(el, cleanup);

          // Compile children with component context
          compile(el, el._scope);
        }
        el._processed = true;
        return;
      }

      // Process directives
      const attrs = Array.from(el.attributes);
      const scopeNode = el._scopeNode || el;
      const currentScope = el._scope || context;

      attrs.forEach((attr) => {
        const name = attr.name;
        const value = attr.value;

        // Shorthand for @ (x-on:)
        if (name.startsWith("@")) {
          const event = name.slice(1);
          directives["on"](el, value, currentScope, event, scopeNode);
          el.removeAttribute(name);
        }
        // Shorthand for : (x-bind:)
        else if (name.startsWith(":")) {
          const arg = name.slice(1);
          directives["bind"](el, value, currentScope, arg, scopeNode);
          el.removeAttribute(name);
        }
        // Full x- directives
        else if (name.startsWith("x-")) {
          const directiveName = name.slice(2);
          const handler = directives[directiveName];

          if (handler) {
            let arg = null;
            // Handle directives with arguments like x-bind:class
            if (directiveName.includes(":")) {
              const parts = directiveName.split(":");
              arg = parts[1];
            }
            handler(el, value, currentScope, arg, scopeNode);
          }
        }
      });
    });
  }

  // ============================================
  // 7. PUBLIC API
  // ============================================

  window.Nexa = {
    version: "0.5.0",

    start(selector = "body") {
      const root =
        typeof selector === "string"
          ? document.querySelector(selector)
          : selector;
      if (root) {
        compile(root, {});
      }
    },

    reactive,
    effect,
    evaluate,
    computed,
    watch,

    defineComponent,

    registerDirective,

    // Plugin system
    plugins: [],
    use(plugin, options) {
      if (typeof plugin === "function") {
        plugin(this, options);
        this.plugins.push({ plugin, options });
      }
      return this;
    },

    // Utility to manually trigger updates
    nextTick(fn) {
      return Promise.resolve().then(fn);
    },
  };
})();
