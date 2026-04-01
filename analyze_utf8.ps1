# Analizar caracteres UTF-8 especiales en main.js
$filePath = "main.js"
$content = Get-Content $filePath -Raw -Encoding UTF8

$lines = $content -split "`n"
$results = @()

$specialChars = @{
    'á' = 'LATIN SMALL LETTER A WITH ACUTE (U+00E1)';
    'é' = 'LATIN SMALL LETTER E WITH ACUTE (U+00E9)';
    'í' = 'LATIN SMALL LETTER I WITH ACUTE (U+00ED)';
    'ó' = 'LATIN SMALL LETTER O WITH ACUTE (U+00F3)';
    'ú' = 'LATIN SMALL LETTER U WITH ACUTE (U+00FA)';
    'ü' = 'LATIN SMALL LETTER U WITH DIAERESIS (U+00FC)';
    'ñ' = 'LATIN SMALL LETTER N WITH TILDE (U+00F1)';
    'Á' = 'LATIN CAPITAL LETTER A WITH ACUTE (U+00C1)';
    'É' = 'LATIN CAPITAL LETTER E WITH ACUTE (U+00C9)';
    'Í' = 'LATIN CAPITAL LETTER I WITH ACUTE (U+00CD)';
    'Ó' = 'LATIN CAPITAL LETTER O WITH ACUTE (U+00D3)';
    'Ú' = 'LATIN CAPITAL LETTER U WITH ACUTE (U+00DA)';
    'Ü' = 'LATIN CAPITAL LETTER U WITH DIAERESIS (U+00DC)';
    'Ñ' = 'LATIN CAPITAL LETTER N WITH TILDE (U+00D1)';
    '€' = 'EURO SIGN (U+20AC)';
    '×' = 'MULTIPLICATION SIGN (U+00D7)';
    '÷' = 'DIVISION SIGN (U+00F7)';
    '©' = 'COPYRIGHT SIGN (U+00A9)';
    '®' = 'REGISTERED SIGN (U+00AE)';
}

for ($lineIdx = 0; $lineIdx -lt $lines.Count; $lineIdx++) {
    $line = $lines[$lineIdx]
    $lineNum = $lineIdx + 1
    
    for ($i = 0; $i -lt $line.Length; $i++) {
        $char = $line[$i]
        
        if ($specialChars.ContainsKey($char)) {
            $start = [Math]::Max(0, $i - 15)
            $end = [Math]::Min($line.Length, $i + 15)
            $context = $line.Substring($start, $end - $start)
            
            $results += @{
                Line = $lineNum
                Position = $i + 1
                Character = $char
                Name = $specialChars[$char]
                Context = "..." + $context + "..."
            }
        }
    }
}

# Print results
Write-Output "=== CARACTERES UTF-8/UNICODE ESPECIALES EN main.js ==="
Write-Output ""

if ($results.Count -eq 0) {
    Write-Output "No se encontraron caracteres especiales en regex patterns."
    Write-Output ""
    Write-Output "Buscando en todo el contenido..."
}

$results | Group-Object -Property Line | ForEach-Object {
    Write-Output ""
    Write-Output "============================================================"
    Write-Output "LINEA: $($_.Name)"
    Write-Output "============================================================"
    
    $_.Group | ForEach-Object {
        Write-Output ""
        Write-Output "  Posición: $($_.Position)"
        Write-Output "  Carácter: [$($_.Character)]"
        Write-Output "  Unicode: $($_.Name)"
        Write-Output "  Contexto: $($_.Context)"
    }
}

Write-Output ""
Write-Output "============================================================"
Write-Output "TOTAL DE CARACTERES ESPECIALES ENCONTRADOS: $($results.Count)"
Write-Output "============================================================"
