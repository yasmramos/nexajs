# NexaJS 🚀

**Buildless Reactive Framework • Ultra Lightweight • HTML-first**

NexaJS is a reactive JavaScript framework that requires no build process. It uses the power of ES6 Proxy for automatic reactivity and integrates directly into your HTML.

## ✨ Features

- ⚡ **No Build**: Direct CDN loading, no webpack or vite needed
- 🎯 **Proxy Reactivity**: Automatic dependency detection
- 📦 **Ultra Lightweight**: Less than 10kb gzipped
- 🔌 **Extensible**: Plugin system and custom directives
- 🌐 **HTML-first**: Write reactive logic directly in your HTML
- 🚀 **No Virtual DOM**: Direct DOM updates

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

| Directive | Description |
|-----------|-------------|
| `x-data` | Defines reactive state |
| `x-text` | Updates text content |
| `x-html` | Inserts dynamic HTML |
| `x-show` | Shows/hides element (CSS) |
| `x-if` | Conditional rendering (DOM) |
| `x-for` | Iterates over lists |
| `x-model` | Two-way binding |
| `x-click` | Handles click events |
| `x-bind` | Attribute binding |

## 📥 Installation

### Option 1: Local Download
Copy `nexajs.js` to your project and include it:

```html
<script src="nexajs.js"></script>
```

### Option 2: CDN (coming soon)
```html
<script src="https://cdn.nexajs.com/nexajs.min.js"></script>
```

## 🧪 Examples

See `index.html` for complete usage examples.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/new-feature`)
3. Commit your changes (`git commit -m 'Add new feature'`)
4. Push to the branch (`git push origin feature/new-feature`)
5. Open a Pull Request

## 📄 License

MIT License - see LICENSE file for details.

---

Made with ❤️ by Yasmín Ramos
