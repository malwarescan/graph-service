const fs = require('fs');
const path = require('path');

const inputFile = path.join(__dirname, 'public', 'dashboard.html');
const backupFile = path.join(__dirname, 'public', 'dashboard.html.backup');

const original = fs.readFileSync(inputFile, 'utf8');
fs.writeFileSync(backupFile, original, 'utf8');

let html = original;

// Remove HTML comments only
html = html.replace(/<!--[\s\S]*?-->/g, '');

// Minify CSS (safe - only remove comments and collapse whitespace)
html = html.replace(/<style\s*>([\s\S]*?)<\/style>/gi, (match, css) => {
  const minified = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,])\s*/g, '$1')
    .replace(/;\s*}/g, ';}')
    .trim();
  return '<style>' + minified + '</style>';
});

// Only remove comments from JS - don't touch whitespace (preserves Vue syntax)
html = html.replace(/<script(\s+[^>]*)?>([\s\S]*?)<\/script>/gi, (match, attrs, js) => {
  if (!js) return match;
  const attrStr = attrs ? attrs.trim() : '';
  // Only remove comments, preserve everything else
  const minified = js
    .replace(/\/\/[^\n\r]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return '<script' + (attrStr ? ' ' + attrStr : '') + '>' + minified;
});

// Remove whitespace between HTML tags (safe)
html = html.replace(/>\s+</g, '><');

fs.writeFileSync(inputFile, html, 'utf8');

const originalSize = original.length;
const newSize = html.length;
const savings = ((1 - newSize / originalSize) * 100).toFixed(1);

console.log(`✅ Minified dashboard.html`);
console.log(`   Original: ${(originalSize / 1024).toFixed(2)} KB (${originalSize} bytes)`);
console.log(`   Minified: ${(newSize / 1024).toFixed(2)} KB (${newSize} bytes)`);
console.log(`   Savings: ${savings}% (${(originalSize - newSize)} bytes)`);
console.log(`   Backup: dashboard.html.backup`);
