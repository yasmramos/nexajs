/**
 * NexaJS - Framework reactivo sin build
 * Versión: 0.1.0
 * Filosofía: Reactividad directa, sin virtual DOM, ultra liviano
 */

(function(global) {
  'use strict';

  const Nexa = {};
  let activeEffect = null;
  const effectStack = [];

  // ============================================
  // 1. MOTOR REACTIVO (Core con Proxy)
  // ============================================
  
  function createReactive(obj, componentId) {
    const listeners = new Map();
    const componentEffects = new Map();

    return new Proxy(obj, {
      get(target, key) {
        track(key);
        return target[key];
      },
      set(target, key, value) {
        if (target[key] === value) return true;
        target[key] = value;
        trigger(key);
        return true;
      }
    });

    function track(key) {
      if (!activeEffect) return;
      
      if (!listeners.has(key)) {
        listeners.set(key, new Set());
      }
      listeners.get(key).add(activeEffect);
      
      // Guardar referencia para cleanup
      if (!componentEffects.has(componentId)) {
        componentEffects.set(componentId, new Set());
      }
      componentEffects.get(componentId).add(activeEffect);
    }

    function trigger(key) {
      const effects = listeners.get(key);
      if (effects) {
        effects.forEach(effect => {
          if (effect !== activeEffect) {
            effect();
          }
        });
      }
    }
  }

  // ============================================
  // 2. SISTEMA DE EFECTOS
  // ============================================
  
  function effect(fn) {
    try {
      activeEffect = fn;
      effectStack.push(fn);
      fn();
    } finally {
      effectStack.pop();
      activeEffect = effectStack.length > 0 ? effectStack[effectStack.length - 1] : null;
    }
  }

  // ============================================
  // 3. EVALUADOR SEGURO
  // ============================================
  
  function evaluate(expr, scope) {
    if (!expr) return '';
    
    try {
      // Soporte para expresiones simples y llamadas a métodos
      const func = new Function('scope', `
        with(scope) {
          try {
            return ${expr};
          } catch(e) {
            return '';
          }
        }
      `);
      return func(scope);
    } catch (e) {
      console.warn('NexaJS eval error:', expr, e);
      return '';
    }
  }

  // ============================================
  // 4. REGISTRO DE DIRECTIVAS
  // ============================================
  
  const directives = {};

  function registerDirective(name, handler) {
    directives[name] = handler;
  }

  // ============================================
  // 5. DIRECTIVAS BASE
  // ============================================
  
  // x-text: Actualiza texto
  registerDirective('text', (el, expr, ctx) => {
    effect(() => {
      const value = evaluate(expr, ctx.data);
      el.textContent = value !== undefined && value !== null ? value : '';
    });
  });

  // x-html: Actualiza HTML interno
  registerDirective('html', (el, expr, ctx) => {
    effect(() => {
      const value = evaluate(expr, ctx.data);
      el.innerHTML = value !== undefined && value !== null ? value : '';
    });
  });

  // x-show: Muestra/oculta elemento
  registerDirective('show', (el, expr, ctx) => {
    effect(() => {
      const show = !!evaluate(expr, ctx.data);
      el.style.display = show ? '' : 'none';
    });
  });

  // x-if: Renderizado condicional (crea/destruye nodo)
  registerDirective('if', (el, expr, ctx) => {
    const placeholder = document.createComment('x-if');
    let mounted = false;
    let clone = null;

    effect(() => {
      const condition = !!evaluate(expr, ctx.data);
      
      if (condition && !mounted) {
        clone = el.cloneNode(true);
        clone.removeAttribute('x-if');
        el.parentNode.insertBefore(clone, el.nextSibling);
        compileElement(clone, ctx);
        mounted = true;
      } else if (!condition && mounted) {
        if (clone && clone.parentNode) {
          clone.parentNode.removeChild(clone);
        }
        clone = null;
        mounted = false;
      }
    });
    
    el.style.display = 'none';
  });

  // x-for: Listas
  registerDirective('for', (el, expr, ctx) => {
    const match = expr.match(/(\w+)\s+in\s+(.+)/);
    if (!match) return;

    const [, itemName, listExpr] = match;
    const placeholder = document.createComment('x-for');
    let previousItems = [];

    effect(() => {
      const list = evaluate(listExpr, ctx.data);
      if (!Array.isArray(list)) return;

      // Limpiar items anteriores
      previousItems.forEach(item => {
        if (item.el && item.el.parentNode) {
          item.el.parentNode.removeChild(item.el);
        }
      });
      previousItems = [];

      // Crear nuevos items
      list.forEach((item, index) => {
        const clone = el.cloneNode(true);
        clone.removeAttribute('x-for');
        
        const itemContext = {
          data: Object.assign({}, ctx.data, {
            [itemName]: item,
            index: index
          })
        };

        compileElement(clone, itemContext);
        el.parentNode.insertBefore(clone, el.nextSibling);
        previousItems.push({ el: clone, item });
      });
    });

    el.style.display = 'none';
  });

  // x-model: Two-way binding
  registerDirective('model', (el, expr, ctx) => {
    // Actualizar vista cuando cambia dato
    effect(() => {
      const value = evaluate(expr, ctx.data);
      if (el.type === 'checkbox') {
        el.checked = !!value;
      } else if (el.type === 'radio') {
        el.checked = el.value == value;
      } else {
        el.value = value !== undefined && value !== null ? value : '';
      }
    });

    // Actualizar dato cuando cambia input
    const eventType = el.type === 'checkbox' || el.type === 'radio' ? 'change' : 'input';
    el.addEventListener(eventType, () => {
      const path = expr.split('.');
      let obj = ctx.data;
      
      for (let i = 0; i < path.length - 1; i++) {
        obj = obj[path[i]];
      }
      
      const lastKey = path[path.length - 1];
      if (el.type === 'checkbox') {
        obj[lastKey] = el.checked;
      } else if (el.type === 'number') {
        obj[lastKey] = Number(el.value);
      } else {
        obj[lastKey] = el.value;
      }
    });
  });

  // x-click: Manejo de eventos click
  registerDirective('click', (el, expr, ctx) => {
    el.addEventListener('click', (event) => {
      const func = evaluate(expr, ctx.data);
      if (typeof func === 'function') {
        func.call(ctx.data, event);
      } else {
        // Evaluar expresión como statement
        try {
          new Function('scope', 'with(scope){ ' + expr + ' }')(ctx.data);
        } catch (e) {
          console.warn('NexaJS click handler error:', expr, e);
        }
      }
    });
  });

  // x-on: Manejo genérico de eventos
  registerDirective('on', (el, expr, ctx) => {
    const [eventName, ...handlerParts] = expr.split(':');
    const handlerExpr = handlerParts.join(':');
    
    el.addEventListener(eventName, (event) => {
      const func = evaluate(handlerExpr, ctx.data);
      if (typeof func === 'function') {
        func.call(ctx.data, event);
      } else {
        try {
          new Function('scope', 'with(scope){ ' + handlerExpr + ' }')(ctx.data);
        } catch (e) {
          console.warn('NexaJS event handler error:', handlerExpr, e);
        }
      }
    });
  });

  // x-bind: Binding dinámico de atributos
  registerDirective('bind', (el, expr, ctx) => {
    effect(() => {
      const value = evaluate(expr, ctx.data);
      
      if (expr === 'class') {
        if (typeof value === 'object') {
          Object.keys(value).forEach(key => {
            if (value[key]) {
              el.classList.add(key);
            } else {
              el.classList.remove(key);
            }
          });
        } else {
          el.className = value || '';
        }
      } else if (expr === 'style') {
        Object.assign(el.style, value || {});
      } else {
        if (value !== undefined && value !== null && value !== false) {
          el.setAttribute(expr, value);
        } else {
          el.removeAttribute(expr);
        }
      }
    });
  });

  // ============================================
  // 6. SISTEMA DE COMPONENTES
  // ============================================
  
  const components = {};

  function defineComponent(name, definition) {
    components[name] = definition;
  }

  function createComponentContext(definition, options = {}) {
    const data = typeof definition.data === 'function' 
      ? definition.data() 
      : definition.data || {};
    
    const methods = definition.methods || {};
    
    const ctx = {
      data: createReactive(Object.assign({}, data, options.data), name),
      methods: methods
    };

    // Mezclar métodos en el contexto de datos para acceso directo
    Object.keys(methods).forEach(key => {
      if (!(key in ctx.data)) {
        ctx.data[key] = methods[key].bind(ctx.data);
      }
    });

    return ctx;
  }

  // ============================================
  // 7. COMPILADOR DOM
  // ============================================
  
  function compileElement(el, ctx) {
    if (!el.attributes) return;

    const attrs = Array.from(el.attributes);
    
    attrs.forEach(attr => {
      const name = attr.name;
      const value = attr.value;

      if (name.startsWith('x-')) {
        const directiveName = name.slice(2);
        const handler = directives[directiveName];
        
        if (handler) {
          handler(el, value, ctx);
        } else {
          console.warn(`NexaJS: Directiva '${directiveName}' no registrada`);
        }
      }
    });

    // Recorrer hijos
    if (el.children) {
      Array.from(el.children).forEach(child => {
        compileElement(child, ctx);
      });
    }
  }

  function compile(root) {
    const elements = root.querySelectorAll('[x-data]');
    
    elements.forEach(el => {
      const dataAttr = el.getAttribute('x-data');
      let ctx;

      // Verificar si es un componente registrado
      if (components[dataAttr]) {
        ctx = createComponentContext(components[dataAttr]);
      } else {
        // Crear contexto inline
        try {
          const dataObj = new Function('return ' + dataAttr)();
          ctx = createComponentContext({ data: dataObj });
        } catch (e) {
          console.error('NexaJS: Error parsing x-data:', dataAttr, e);
          return;
        }
      }

      // Compilar elemento y sus hijos
      compileElement(el, ctx);
    });
  }

  // ============================================
  // 8. API PÚBLICA
  // ============================================
  
  Nexa = {
    version: '0.1.0',
    
    start: function(selector = 'body') {
      const root = typeof selector === 'string' 
        ? document.querySelector(selector) 
        : selector;
      
      if (root) {
        compile(root);
      }
      
      return this;
    },

    directive: registerDirective,
    
    component: defineComponent,
    
    reactive: function(obj) {
      return createReactive(obj, 'global');
    },

    effect: effect,

    use: function(plugin, options) {
      if (typeof plugin.install === 'function') {
        plugin.install(Nexa, options);
      } else if (typeof plugin === 'function') {
        plugin(Nexa, options);
      }
      return this;
    }
  };

  // Exportar globalmente
  global.Nexa = Nexa;

  // Auto-inicializar si hay elementos x-data al cargar
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      Nexa.start();
    });
  } else {
    Nexa.start();
  }

})(typeof window !== 'undefined' ? window : global);
