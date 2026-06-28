/**
 * validate-build.mjs — Post-build validation for Chrome extension JS files.
 *
 * 1. Strict-mode parse via acorn
 * 2. Regex scan for const/let shadowing patterns: const e=e=>...
 *
 * Usage: node validate-build.mjs <dist-directory>
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parse } from 'acorn';

const distDir = process.argv[2];
if (!distDir) {
  console.error('Usage: node validate-build.mjs <dist-directory>');
  process.exit(1);
}

const SHADOW_REGEX = /\b(const|let)\s+(\w+)\s*=\s*\2\s*=>/g;

let errors = 0;

function collectJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...collectJsFiles(full));
    else if (entry.endsWith('.js')) files.push(full);
  }
  return files;
}

const jsFiles = collectJsFiles(distDir);

for (const file of jsFiles) {
  const relPath = file.replace(distDir + '/', '');
  const code = readFileSync(file, 'utf-8');

  SHADOW_REGEX.lastIndex = 0;
  let match;
  while ((match = SHADOW_REGEX.exec(code)) !== null) {
    const lineNum = code.substring(0, match.index).split('\n').length;
    const col = match.index - code.lastIndexOf('\n', match.index - 1);
    console.error(`  FAIL [shadow] ${relPath}:${lineNum}:${col} — "${match[0]}"`);
    errors++;
  }

  try {
    parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowReserved: false,
    });
  } catch (e) {
    console.error(`  FAIL [parse] ${relPath}:${e.loc?.line}:${e.loc?.column} — ${e.message}`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\n  ${errors} error(s) found in ${jsFiles.length} files.`);
  process.exit(1);
} else {
  console.log(`  All ${jsFiles.length} files passed validation.`);
  process.exit(0);
}
