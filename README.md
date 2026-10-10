# NexaJS 🚀

**Buildless Reactive Framework • Ultra Lightweight • HTML-first**

NexaJS is a reactive JavaScript framework that requires no build process. It uses the power of ES6 Proxy for automatic reactivity and integrates directly into your HTML.

## ✨ Features

- ⚡ **No Build**: Direct CDN loading, no webpack or vite needed
- 🎯 **Proxy Reactivity**: Automatic dependency detection
- 📦 **Ultra Lightweight**: Less than 10kb minified (~9.5 KB)
- 🔌 **Extensible**: Plugin system and custom directives
- 🌐 **HTML-first**: Write reactive logic directly in your HTML
- 🚀 **No Virtual DOM**: Direct DOM updates
- 🛡️ **Enhanced Error Handling**: Global error events and graceful degradation
- 📘 **TypeScript Support**: Full type definitions included

## 🚀 Quick Start

```html
<!DOCTYPE html>
<html>
<head>
  <title>My NexaJS App</title>
</head>
<body>
  <div x-data="{ count: 0 }">
    <button x-click="count++">Increment</button>
    <span x-text="count">0</span>
  </div>
  
  <script src="nexajs.js"></script>
</body>
</html>
```

## 📖 Directives

| Directive | Shorthand | Description |
|-----------|-----------|-------------|
| `x-data` | - | Defines reactive state |
| `x-text` | - | Updates text content |
| `x-html` | - | Inserts dynamic HTML |
| `x-show` | - | Shows/hides element (CSS) |
| `x-if` | - | Conditional rendering (DOM) |
| `x-for` | - | Iterates over lists |
| `x-model` | - | Two-way binding |
| `x-on:click` | `@click` | Event handling |
| `x-bind:class` | `:class` | Attribute binding |

## 📥 Installation

### Option 1: Local Download
Copy `nexajs.js` to your project and include it:

```html
<script src="nexajs.js"></script>
```

### Option 2: Use Minified Version
For production, use the minified version:

```html
<script src="nexajs.min.js"></script>
```

### Option 3: TypeScript Project
Install types by copying `types/nexajs.d.ts` to your project:

```typescript
/// <reference path="./types/nexajs.d.ts" />
```

## 🧪 Examples

### Basic Counter
```html
<div x-data="{ count: 0 }">
  <button @click="count++">+</button>
  <span x-text="count"></span>
</div>
```

### Two-Way Binding
```html
<div x-data="{ name: '' }">
  <input x-model="name" placeholder="Enter name">
  <p>Hello, <span x-text="name"></span>!</p>
</div>
```

### List Rendering
```html
<div x-data="{ items: ['A', 'B', 'C'] }">
  <template x-for="item in items">
    <div x-text="item"></div>
  </template>
</div>
```

### Computed Properties
```javascript
const state = Nexa.reactive({ price: 10, quantity: 2 });
const total = Nexa.computed(() => state.price * state.quantity);
console.log(total.value); // 20
```

### Watchers
```javascript
const state = Nexa.reactive({ count: 0 });
Nexa.watch(() => state.count, (newVal, oldVal) => {
  console.log(`Count changed from ${oldVal} to ${newVal}`);
}, { immediate: true });
```

### Components
```javascript
Nexa.defineComponent('user-card', {
  props: ['name', 'email'],
  template: `
    <div class="card">
      <h3 x-text="name"></h3>
      <p x-text="email"></p>
    </div>
  `,
  onMounted() {
    console.log('Component mounted!');
  }
});
```

## 🧪 Testing

Run the test suite by opening `test.html` in your browser. The comprehensive test suite includes:

- ✅ Reactivity tests (basic, nested, deep)
- ✅ Computed properties tests
- ✅ Watcher tests (with options)
- ✅ Effect tests (execution, stop)
- ✅ Error handling tests
- ✅ Directive tests

## 🛡️ Error Handling

NexaJS v0.4.0 introduces robust error handling:

- **Global Error Events**: Listen to `nexajs:error` events
- **Graceful Degradation**: Invalid operations don't crash the framework
- **Detailed Context**: Error messages include operation context
- **Cleanup Protection**: Cleanup functions are wrapped in try-catch

```javascript
window.addEventListener('nexajs:error', (e) => {
  console.error('NexaJS Error:', e.detail.error);
  console.error('Context:', e.detail.context);
});
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/new-feature`)
3. Commit your changes (`git commit -m 'Add new feature'`)
4. Push to the branch (`git push origin feature/new-feature`)
5. Open a Pull Request

## 📄 License

Apache 2.0 License - see LICENSE file for details.

---

Created by Yasmany Ramos García

## 📊 Performance

- **Minified Size**: ~9.5 KB
- **Source Lines**: ~965 lines
- **Memory Efficient**: WeakMap-based caching
- **Batch Updates**: Microtask-based scheduler
