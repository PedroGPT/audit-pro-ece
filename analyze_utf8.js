const fs = require('fs');
const content = fs.readFileSync('main.js', 'utf8');
const lines = content.split('\n');

const results = [];

lines.forEach((line, lineIdx) => {
  const lineNum = lineIdx + 1;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const code = char.charCodeAt(0);
    
    // Detectar caracteres no-ASCII (>127) o especiales
    if (code > 127 || 
        char === '\u200B' || char === '\u200C' || char === '\u200D' || // Zero-width chars
        char === '\uFEFF' || // BOM
        (code >= 0xD800 && code <= 0xDBFF)) { // Part of surrogate pair (emoji)
      
      // Get Unicode name
      let charName = 'UNKNOWN';
      let hexCode = code.toString(16).toUpperCase().padStart(4, '0');
      
      if (char === '\u200B') charName = 'ZERO WIDTH SPACE';
      else if (char === '\u200C') charName = 'ZERO WIDTH NON-JOINER';
      else if (char === '\u200D') charName = 'ZERO WIDTH JOINER';
      else if (char === '\uFEFF') charName = 'ZERO WIDTH NO-BREAK SPACE (BOM)';
      else if (char === 'á') charName = 'LATIN SMALL LETTER A WITH ACUTE';
      else if (char === 'é') charName = 'LATIN SMALL LETTER E WITH ACUTE';
      else if (char === 'í') charName = 'LATIN SMALL LETTER I WITH ACUTE';
      else if (char === 'ó') charName = 'LATIN SMALL LETTER O WITH ACUTE';
      else if (char === 'ú') charName = 'LATIN SMALL LETTER U WITH ACUTE';
      else if (char === 'ü') charName = 'LATIN SMALL LETTER U WITH DIAERESIS';
      else if (char === 'ñ') charName = 'LATIN SMALL LETTER N WITH TILDE';
      else if (char === 'Á') charName = 'LATIN CAPITAL LETTER A WITH ACUTE';
      else if (char === 'É') charName = 'LATIN CAPITAL LETTER E WITH ACUTE';
      else if (char === 'Í') charName = 'LATIN CAPITAL LETTER I WITH ACUTE';
      else if (char === 'Ó') charName = 'LATIN CAPITAL LETTER O WITH ACUTE';
      else if (char === 'Ú') charName = 'LATIN CAPITAL LETTER U WITH ACUTE';
      else if (char === 'Ü') charName = 'LATIN CAPITAL LETTER U WITH DIAERESIS';
      else if (char === 'Ñ') charName = 'LATIN CAPITAL LETTER N WITH TILDE';
      
      // Get context (3-4 words around)
      const start = Math.max(0, i - 20);
      const end = Math.min(line.length, i + 20);
      const context = line.slice(start, end).replace(/\n/g, ' ');
      
      results.push({
        line: lineNum,
        position: i + 1,
        char: char,
        charCode: 'U+' + hexCode,
        name: charName,
        context: context.trim()
      });
    }
  }
});

// Print results grouped by line
let currentLine = -1;
results.forEach(r => {
  if (r.line !== currentLine) {
    console.log('\n=== LÍNEA ' + r.line + ' ===');
    currentLine = r.line;
  }
  console.log('  Pos ' + r.position + ': "' + r.char + '" [' + r.charCode + '] - ' + r.name);
  console.log('           Contexto: ...' + r.context + '...');
});

console.log('\n\nTOTAL DE CARACTERES ESPECIALES ENCONTRADOS: ' + results.length);

// Also output JSON for detailed analysis
console.log('\n\n=== ANÁLISIS JSON ===');
console.log(JSON.stringify(results, null, 2));
