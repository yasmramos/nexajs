# NexaJS 🚀

**Framework reactivo sin build • Ultra liviano • HTML-first**

NexaJS es un framework JavaScript reactivo que no requiere proceso de compilación. Usa el poder de ES6 Proxy para reactividad automática y se integra directamente en tu HTML.

## ✨ Características

- ⚡ **Sin Build**: Carga directa desde CDN, sin webpack ni vite
- 🎯 **Reactividad Proxy**: Detección automática de dependencias
- 📦 **Ultra Liviano**: Menos de 10kb gzipped
- 🔌 **Extensible**: Sistema de plugins y directivas personalizadas
- 🌐 **HTML-first**: Escribe lógica reactiva directamente en tu HTML
- 🚀 **Sin Virtual DOM**: Actualizaciones directas al DOM

## 🚀 Inicio Rápido

```html
<!DOCTYPE html>
<html>
<head>
  <title>Mi App NexaJS</title>
</head>
<body>
  <div x-data="{ count: 0 }">
    <button x-click="count++">Incrementar</button>
    <span x-text="count">0</span>
  </div>

  <script src="nexajs.js"></script>
</body>
</html>
```

## 📖 Directivas

| Directiva | Descripción |
|-----------|-------------|
| `x-data` | Define estado reactivo |
| `x-text` | Actualiza contenido de texto |
| `x-html` | Inserta HTML dinámico |
| `x-show` | Muestra/oculta elemento (CSS) |
| `x-if` | Renderizado condicional (DOM) |
| `x-for` | Itera sobre listas |
| `x-model` | Two-way binding |
| `x-click` | Maneja eventos click |
| `x-bind` | Binding de atributos |

## 📥 Instalación

### Opción 1: Descargar local
Copia `nexajs.js` en tu proyecto e inclúyelo:

```html
<script src="nexajs.js"></script>
```

### Opción 2: CDN (próximamente)
```html
<script src="https://cdn.nexajs.com/nexajs.min.js"></script>
```

## 🧪 Ejemplos

Ver `index.html` para ejemplos completos de uso.

## 🤝 Contribuir

1. Fork el repositorio
2. Crea una rama feature (`git checkout -b feature/nueva-funcionalidad`)
3. Commit tus cambios (`git commit -m 'Añadir nueva funcionalidad'`)
4. Push a la rama (`git push origin feature/nueva-funcionalidad`)
5. Abre un Pull Request

## 📄 Licencia

MIT License - ver archivo LICENSE para detalles.

---

Hecho con ❤️ por Yasmín Ramos
