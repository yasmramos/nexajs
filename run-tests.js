const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

// Leer el archivo HTML de test y el script de NexaJS
const testHTML = fs.readFileSync(path.join(__dirname, 'test.html'), 'utf8');
const nexajsScript = fs.readFileSync(path.join(__dirname, 'nexajs.js'), 'utf8');

// Reemplazar la etiqueta script que carga nexajs.js con el contenido inline
let modifiedHTML = testHTML.replace(
  /<script\s+src="nexajs\.js"><\/script>/g,
  `<script>${nexajsScript}</script>`
);

// Agregar polyfill para CustomEvent en JSDOM
const customEventPolyfill = `
if (typeof window.CustomEvent !== 'function') {
  window.CustomEvent = function(event, params) {
    params = params || { bubbles: false, cancelable: false, detail: undefined };
    var evt = document.createEvent('CustomEvent');
    evt.initCustomEvent(event, params.bubbles, params.cancelable, params.detail);
    return evt;
  };
  window.CustomEvent.prototype = window.Event.prototype;
}
`;

modifiedHTML = modifiedHTML.replace(
  /<\/head>/,
  `<script>${customEventPolyfill}</script></head>`
);

// Crear un entorno JSDOM
const dom = new JSDOM(modifiedHTML, {
  runScripts: 'dangerously',
  resources: 'usable',
  url: 'http://localhost/',
  pretendToBeVisual: true,
  beforeParse(window) {
    // Mock de requestAnimationFrame
    window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  }
});

const { window } = dom;

// Esperar a que los tests se ejecuten
setTimeout(() => {
  const resultsDiv = window.document.getElementById('results');
  const summaryDiv = window.document.getElementById('summary');
  
  if (summaryDiv) {
    console.log('\n' + '='.repeat(60));
    console.log(summaryDiv.textContent.trim());
    console.log('='.repeat(60) + '\n');
    
    // Extraer resultados individuales
    const testResults = resultsDiv.querySelectorAll('.test-result');
    let passed = 0;
    let failed = 0;
    
    testResults.forEach(result => {
      const isPass = result.classList.contains('pass');
      const testName = result.querySelector('strong')?.textContent || 'Unknown test';
      
      if (isPass) {
        passed++;
        console.log(`✅ PASS: ${testName}`);
      } else {
        failed++;
        const errorMsg = result.querySelector('.error-message')?.textContent || '';
        console.log(`❌ FAIL: ${testName}`);
        if (errorMsg) console.log(`   Error: ${errorMsg.trim()}`);
      }
    });
    
    console.log('\n' + '-'.repeat(60));
    console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
    console.log('-'.repeat(60) + '\n');
    
    // Salir con código de error si hay tests fallidos
    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } else {
    console.error('Error: No se pudo encontrar el resumen de tests');
    process.exit(1);
  }
}, 3000);
