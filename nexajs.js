/**
 * NexaJS - A lightweight reactive framework without build steps
 * Author: Yasmany Ramos García
 * License: Apache 2.0
 */

(function () {
  'use strict';

  // --- 1. Core Reactivity System with Scheduler ---
  const queue = new Set();
  let isFlushing = false;

  function scheduleEffect(effect) {
    queue.add(effect);
    if (!isFlushing) {
      isFlushing = true;
      Promise.resolve().then(flushQueue);
    }
  }

  function flushQueue() {
    queue.forEach((effect) => effect());
    queue.clear();
    isFlushing = false;
  }

  let activeEffect = null;
  const targetMap = new WeakMap();

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
      activeEffect.deps.push(dep);
    }
  }

  function trigger(target, key) {
    const depsMap = targetMap.get(target);
    if (!depsMap) return;
    const dep = depsMap.get(key);
    if (dep) {
      dep.forEach((effect) => {
        if (effect !== activeEffect) {
          scheduleEffect(effect);
        }
      });
    }
  }

  function reactive(obj) {
    return new Proxy(obj, {
      get(target, key, receiver) {
        track(target, key);
        const result = Reflect.get(target, key, receiver);
        if (typeof result === 'object' && result !== null) {
          return reactive(result);
        }
        return result;
      },
      set(target, key, value, receiver) {
        const oldValue = target[key];
        if (oldValue === value) return true;
        target[key] = value;
        trigger(target, key);
        return true;
      },
      deleteProperty(target, key) {
        const hadKey = Object.prototype.hasOwnProperty.call(target, key);
        delete target[key];
        if (hadKey) trigger(target, key);
        return true;
      }
    });
  }

  function effect(fn) {
    const runner = () => {
      if (runner.cleanup) runner.cleanup();
      runner.cleanup = [];
      activeEffect = runner;
      try {
        return fn();
      } finally {
        activeEffect = null;
      }
    };
    runner.deps = [];
    runner();
    return runner;
  }

  // --- 2. Safe Expression Evaluator with Cache ---
  const expressionCache = new Map();

  function compileExpression(expr) {
    if (expressionCache.has(expr)) {
      return expressionCache.get(expr);
    }
    try {
      const fn = new Function('scope', `
        with(scope) {
          try { return ${expr}; } catch(e) { console.warn('NexaJS Eval Error:', e); return ''; }
        }
      `);
      expressionCache.set(expr, fn);
      return fn;
    } catch (e) {
      console.error('NexaJS: Invalid expression', expr, e);
      return () => '';
    }
  }

  function evaluate(expr, scope) {
    const fn = compileExpression(expr);
    return fn(scope);
  }

  // --- 3. DOM Utilities & Cleanup ---
  const nodeStore = new WeakMap();

  function getCleanupList(node) {
    if (!nodeStore.has(node)) {
      nodeStore.set(node, []);
    }
    return nodeStore.get(node);
  }

  function addCleanup(node, fn) {
    getCleanupList(node).push(fn);
  }

  function destroyNode(node) {
    const cleanups = nodeStore.get(node);
    if (cleanups) {
      cleanups.forEach((fn) => fn());
      nodeStore.delete(node);
    }
    if (node.nodeType === 1) {
      Array.from(node.children).forEach(destroyNode);
    }
  }

  // --- 4. Directives System ---
  const directives = {};

  function registerDirective(name, handler) {
    directives[name] = handler;
  }

  // x-text
  registerDirective('text', (el, expr, ctx) => {
    const update = () => {
      el.textContent = evaluate(expr, ctx);
    };
    effect(update);
  });

  // x-html
  registerDirective('html', (el, expr, ctx) => {
    const update = () => {
      el.innerHTML = evaluate(expr, ctx);
    };
    effect(update);
  });

  // x-show
  registerDirective('show', (el, expr, ctx) => {
    const originalDisplay = el.style.display || '';
    const update = () => {
      const show = !!evaluate(expr, ctx);
      el.style.display = show ? originalDisplay : 'none';
    };
    effect(update);
  });

  // x-if
  registerDirective('if', (el, expr, ctx) => {
    const anchor = document.createComment('x-if');
    const parent = el.parentNode;
    parent.insertBefore(anchor, el);
    
    let mounted = false;
    let instance = null;

    const update = () => {
      const show = !!evaluate(expr, ctx);
      if (show === mounted) return;

      if (show) {
        if(el.tagName === 'TEMPLATE') {
           const content = el.content.cloneNode(true);
           parent.insertBefore(content, anchor);
           instance = content; 
           compile(content, ctx);
        } else {
           el.style.display = '';
           mounted = true;
           return;
        }
        mounted = true;
      } else {
        if (instance) {
          destroyNode(instance);
          instance.remove();
          instance = null;
        } else {
           el.style.display = 'none';
        }
        mounted = false;
      }
    };
    
    if (el.tagName !== 'TEMPLATE') {
       console.warn('x-if works best with <template> tags');
       el.style.display = 'none';
    }
    
    effect(update);
    
    addCleanup(anchor, () => {
      if (instance) instance.remove();
    });
  });

  // x-for (With Keyed Diffing)
  registerDirective('for', (el, expr, ctx) => {
    const anchor = document.createComment('x-for');
    const parent = el.parentNode;
    parent.insertBefore(anchor, el);
    el.remove();

    const parts = expr.split(/\s+(in|of)\s+/);
    const itemStr = parts[0];
    const listExpr = parts[2];
    const itemName = itemStr.replace('(', '').replace(')', '');
    
    const listFn = compileExpression(listExpr);
    const nodeMap = new Map();

    const update = () => {
      const list = listFn(ctx) || [];
      const newKeys = list.map((item, i) => (item && item.id) ? item.id : i);

      const oldKeys = Array.from(nodeMap.keys());
      
      // Remove deleted
      oldKeys.forEach(key => {
        if (!newKeys.includes(key)) {
          const node = nodeMap.get(key);
          destroyNode(node);
          node.remove();
          nodeMap.delete(key);
        }
      });

      // Update/Insert
      let currentAnchor = anchor;
      newKeys.forEach((key, i) => {
        const item = list[i];
        const itemScope = { [itemName]: item };
        const mergedScope = { ...ctx, ...itemScope };

        if (nodeMap.has(key)) {
          const node = nodeMap.get(key);
          if (node.previousSibling !== currentAnchor) {
            parent.insertBefore(node, currentAnchor.nextSibling);
          }
          node._scope = mergedScope;
          currentAnchor = node;
        } else {
          const clone = el.content.cloneNode(true);
          parent.insertBefore(clone, currentAnchor.nextSibling);
          
          let last = currentAnchor;
          let temp = currentAnchor.nextSibling;
          while(temp && temp !== anchor) {
             if(temp.nodeType === 1) {
                temp._scope = mergedScope;
                compile(temp, mergedScope);
                last = temp;
             }
             temp = temp.nextSibling;
          }
          nodeMap.set(key, last);
          currentAnchor = last;
        }
      });
    };

    effect(update);
    
    addCleanup(anchor, () => {
      nodeMap.forEach(node => destroyNode(node));
      nodeMap.clear();
    });
  });

  // x-model
  registerDirective('model', (el, expr, ctx) => {
    const setVal = (val) => {
      const parts = expr.split('.');
      let obj = ctx;
      for (let i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]];
      }
      obj[parts.pop()] = val;
    };

    const getVal = () => evaluate(expr, ctx);

    const updateView = () => {
      const val = getVal();
      if (el.type === 'checkbox') {
        el.checked = !!val;
      } else if (el.type === 'radio') {
        el.checked = el.value == val;
      } else {
        el.value = val ?? '';
      }
    };

    const updateModel = (e) => {
      let val;
      if (el.type === 'checkbox') val = el.checked;
      else if (el.type === 'number') val = parseFloat(el.value);
      else val = el.value;
      setVal(val);
    };

    el.addEventListener('input', updateModel);
    if (el.type === 'checkbox' || el.type === 'radio') {
      el.addEventListener('change', updateModel);
    }

    effect(updateView);
    
    addCleanup(el, () => {
      el.removeEventListener('input', updateModel);
      el.removeEventListener('change', updateModel);
    });
  });

  // x-on / @
  registerDirective('on', (el, expr, ctx, arg) => {
    const event = arg;
    const handlerFn = compileExpression(expr);
    
    const listener = (e) => {
      const eventScope = { ...ctx, $event: e };
      handlerFn(eventScope);
    };

    el.addEventListener(event, listener);
    addCleanup(el, () => {
      el.removeEventListener(event, listener);
    });
  });

  // x-bind / :
  registerDirective('bind', (el, expr, ctx, arg) => {
    const attr = arg;
    const update = () => {
      const val = evaluate(expr, ctx);
      if (attr === 'class') {
        if (typeof val === 'string') {
          el.className = val;
        } else if (typeof val === 'object') {
          el.classList = '';
          Object.entries(val).forEach(([k, v]) => {
            if (v) el.classList.add(k);
          });
        }
      } else if (attr === 'style') {
        Object.assign(el.style, val || {});
      } else if (typeof val === 'boolean') {
        if (val) el.setAttribute(attr, '');
        else el.removeAttribute(attr);
      } else {
        el.setAttribute(attr, val ?? '');
      }
    };
    effect(update);
  });

  // --- 5. Component System ---
  const components = {};

  function defineComponent(name, definition) {
    components[name] = definition;
  }

  function createComponentContext(def, propsData, parentCtx) {
    const { data = {}, methods = {}, props = [], onMounted, onUnmounted } = def;
    
    const propObj = {};
    if (props) {
      props.forEach(p => {
        propObj[p] = propsData[p];
      });
    }

    const state = reactive({ ...data, ...propObj });

    const boundMethods = {};
    if (methods) {
      Object.keys(methods).forEach(key => {
        boundMethods[key] = methods[key].bind(state);
      });
    }

    const ctx = { ...state, ...boundMethods };
    
    if (onMounted) setTimeout(() => onMounted.call(state), 0);
    
    const cleanup = () => {
      if (onUnmounted) onUnmounted.call(state);
    };

    return { ctx, cleanup };
  }

  // --- 6. Compiler ---
  function compile(root, context) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const nodesToProcess = [];

    while (walker.nextNode()) {
      nodesToProcess.push(walker.currentNode);
    }

    nodesToProcess.forEach(el => {
      if (!el.getAttribute) return;

      const compName = el.getAttribute('x-component');
      if (compName && !el._processed) {
        const def = components[compName];
        if (def) {
          const propsData = {};
          Array.from(el.attributes).forEach(attr => {
            if (attr.name.startsWith(':')) {
               const propName = attr.name.slice(1);
               propsData[propName] = evaluate(attr.value, context);
            } else if (!attr.name.startsWith('x-')) {
               propsData[attr.name] = attr.value;
            }
          });
          
          const { ctx: compCtx, cleanup } = createComponentContext(def, propsData, context);
          el._scope = compCtx;
          el._cleanup = cleanup;
          addCleanup(el, cleanup);
          compile(el, compCtx); 
        }
        el._processed = true;
        return;
      }

      const attrs = Array.from(el.attributes);
      attrs.forEach(attr => {
        const name = attr.name;
        const value = attr.value;

        if (name.startsWith('@')) {
          const event = name.slice(1);
          directives['on'](el, value, el._scope || context, event);
          el.removeAttribute(name);
        } else if (name.startsWith(':')) {
          const arg = name.slice(1);
          directives['bind'](el, value, el._scope || context, arg);
          el.removeAttribute(name);
        } else if (name.startsWith('x-')) {
          const directiveName = name.slice(2);
          const handler = directives[directiveName];
          if (handler) {
            let arg = null;
            if (directiveName.includes(':')) {
              const parts = directiveName.split(':');
              handler(el, value, el._scope || context, parts[1]);
            } else {
              handler(el, value, el._scope || context, null);
            }
          }
        }
      });
    });
  }

  // --- 7. Public API ---
  window.Nexa = {
    start(selector = 'body') {
      const root = typeof selector === 'string' ? document.querySelector(selector) : selector;
      if (root) {
        compile(root, {});
      }
    },
    reactive,
    effect,
    defineComponent,
    registerDirective
  };

})();
