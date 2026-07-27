import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const name = process.argv[2]?.replace(/^@kouro\//, '');

if (!name) {
  process.stderr.write('Usage: bun run create-package <name>\n');
  process.exit(1);
}

if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  process.stderr.write('Package name must be lowercase alphanumeric with dashes.\n');
  process.exit(1);
}

const dir = resolve(import.meta.dir, '..', 'packages', name);

if (existsSync(dir)) {
  process.stderr.write(`Package '${name}' already exists at packages/${name}\n`);
  process.exit(1);
}

mkdirSync(resolve(dir, 'src'), { recursive: true });

writeFileSync(
  resolve(dir, 'package.json'),
  JSON.stringify(
    {
      name: `@kouro/${name}`,
      private: true,
      type: 'module',
      exports: {
        '.': {
          default: './src/index.ts',
        },
      },
    },
    null,
    2,
  ) + '\n',
);

writeFileSync(resolve(dir, 'src', 'index.ts'), '');

process.stdout.write(`Created package @kouro/${name} at packages/${name}\n`);
