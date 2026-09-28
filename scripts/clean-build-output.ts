/** Removes SDK build output in a shell-independent way. */
import fs from 'node:fs';
import path from 'node:path';

fs.rmSync(path.join(import.meta.dirname, '..', 'dist'), { recursive: true, force: true });
