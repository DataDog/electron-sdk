import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

interface RuntimePackage {
  directory: string;
  dependencies?: Record<string, string>;
}

interface PackageReplacement {
  name: string;
  destination: string;
  backup: string;
  backedUp: boolean;
  installed: boolean;
}

/** Stages the SDK's runtime dependency tree without relying on package-manager hoisting or links. */
export async function copyRuntimeDependencies(outDir: string, resolveFrom: NodeRequire): Promise<void> {
  const roots = new Map<string, RuntimePackage>();
  for (const name of ['dd-trace-electron', '@datadog/electron-sdk']) {
    roots.set(name, await resolvePackage(name, resolveFrom));
  }
  const ancestors = new Map([...roots].map(([name, pkg]) => [name, pkg.directory]));
  for (const [name, pkg] of roots) {
    const destination = join(outDir, 'node_modules', name);
    const existingDirectory = await fs.realpath(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    // A build in the project root must leave its installed packages and dependency links intact.
    if (existingDirectory === pkg.directory) return;
  }

  const modules = join(outDir, 'node_modules');
  await fs.mkdir(modules, { recursive: true });
  const staging = await fs.mkdtemp(join(modules, '.datadog-runtime-'));
  try {
    // Finish reading every source tree before replacing any existing output.
    for (const [name, pkg] of roots) {
      await copyPackageTree(name, pkg, join(staging, name), ancestors);
    }
    await replacePackages([...roots.keys()], staging, modules);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function resolvePackage(name: string, resolveFrom: NodeRequire): Promise<RuntimePackage> {
  try {
    let directory: string;
    try {
      directory = dirname(resolveFrom.resolve(`${name}/package.json`));
    } catch {
      // Some packages hide their manifest behind an exports map.
      directory = dirname(resolveFrom.resolve(name));
      while (true) {
        try {
          await fs.access(join(directory, 'package.json'));
          break;
        } catch {
          const parent = dirname(directory);
          if (parent === directory) throw new Error(`Cannot find package.json for '${name}'`);
          directory = parent;
        }
      }
    }
    const manifest = JSON.parse(await fs.readFile(join(directory, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    return { directory: await fs.realpath(directory), dependencies: manifest.dependencies };
  } catch (cause) {
    throw Object.assign(new Error(`[datadog] Failed to resolve runtime package '${name}'`), { cause });
  }
}

async function copyPackageTree(
  name: string,
  pkg: RuntimePackage,
  destination: string,
  ancestors: Map<string, string>
): Promise<void> {
  try {
    await fs.mkdir(dirname(destination), { recursive: true });
    await fs.cp(pkg.directory, destination, {
      recursive: true,
      dereference: true,
      // Reconstruct dependency edges ourselves; copying installation links can point back to the build machine.
      filter: (source) => source !== join(pkg.directory, 'node_modules'),
    });
    await makeDirectoriesWritable(destination);
  } catch (cause) {
    throw Object.assign(new Error(`[datadog] Failed to copy runtime package '${name}' to '${destination}'`), { cause });
  }

  const resolveFrom = createRequire(join(pkg.directory, 'package.json'));
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    const child = await resolvePackage(dependency, resolveFrom);
    // Reuse an ancestor only when Node's lookup will reach the same installed package instance.
    if (ancestors.get(dependency) === child.directory) continue;
    await copyPackageTree(
      dependency,
      child,
      join(destination, 'node_modules', dependency),
      new Map(ancestors).set(dependency, child.directory)
    );
  }
}

async function makeDirectoriesWritable(destination: string): Promise<void> {
  // Bazel's package directories are read-only. Copies need to accept dependencies and be removable on rebuild.
  const entries = await fs.readdir(destination, { recursive: true, withFileTypes: true });
  const directories = [
    destination,
    ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(entry.parentPath, entry.name)),
  ];
  for (const directory of directories) {
    const { mode } = await fs.stat(directory);
    if ((mode & 0o200) === 0) await fs.chmod(directory, mode | 0o200);
  }
}

async function replacePackages(names: string[], staging: string, modules: string): Promise<void> {
  const replacements: PackageReplacement[] = names.map((name) => {
    const destination = join(modules, name);
    return {
      name,
      destination,
      // Backups survive staging cleanup if restoration fails.
      backup: join(dirname(destination), `${basename(staging)}-${basename(destination)}-previous`),
      backedUp: false,
      installed: false,
    };
  });
  for (const replacement of replacements) {
    const { name, destination, backup } = replacement;
    try {
      await fs.mkdir(dirname(destination), { recursive: true });
      try {
        await fs.rename(destination, backup);
        replacement.backedUp = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await fs.rename(join(staging, name), destination);
      replacement.installed = true;
    } catch (cause) {
      const restoreErrors = await restorePackages(replacements);
      throw Object.assign(new Error(`[datadog] Failed to replace runtime package '${name}' at '${destination}'`), {
        cause,
        restoreErrors,
      });
    }
  }
  // Commit only after every root is installed; earlier roots must remain recoverable until then.
  for (const { backedUp, backup } of replacements) {
    if (backedUp) await fs.rm(backup, { recursive: true, force: true });
  }
}

async function restorePackages(replacements: PackageReplacement[]): Promise<Error[]> {
  const errors: Error[] = [];
  for (const { name, destination, backup, backedUp, installed } of [...replacements].reverse()) {
    try {
      if (installed) await fs.rm(destination, { recursive: true, force: true });
      if (backedUp) await fs.rename(backup, destination);
    } catch (cause) {
      const message = backedUp
        ? `Previous runtime package '${name}' preserved at '${backup}'`
        : `Failed to remove newly copied runtime package '${name}' at '${destination}'`;
      errors.push(Object.assign(new Error(message), { cause }));
    }
  }
  return errors;
}
