import path from 'node:path';
import fs from 'node:fs';

// Tries <import>.ts then <import>/index.ts — covers extensionless relative imports
function resolveImport(importPath, currentFile) {
  const base = path.resolve(path.dirname(currentFile), importPath);
  const tsFile = `${base}.ts`;
  if (fs.existsSync(tsFile)) return tsFile;
  const indexFile = path.join(base, 'index.ts');
  if (fs.existsSync(indexFile)) return indexFile;
  return null;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid importing internal modules when a barrel file exists' },
    messages: {
      forbidden: "'{{target}}' is an internal module. Import from '{{barrel}}' instead.",
    },
    schema: [],
  },
  create(context) {
    function check(node) {
      const source = node.source?.value;
      if (!source?.startsWith('.')) return;

      const currentFile = context.physicalFilename ?? context.filename;
      const resolved = resolveImport(source, currentFile);
      if (!resolved) return;

      const targetDir = path.dirname(resolved);
      const barrelFile = path.join(targetDir, 'index.ts');

      if (!fs.existsSync(barrelFile)) return;
      if (resolved === barrelFile) return;

      const currentDir = path.dirname(currentFile);
      const rel = path.relative(targetDir, currentDir);
      if (!rel.startsWith('..')) return; // current file is inside targetDir — allowed

      const projectRoot = process.cwd();
      context.report({
        node,
        messageId: 'forbidden',
        data: {
          target: path.relative(projectRoot, resolved),
          barrel: path.relative(projectRoot, barrelFile),
        },
      });
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    };
  },
};
