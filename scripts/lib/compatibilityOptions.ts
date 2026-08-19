import type { CompatibilityAppTemplate, CompatibilityAppVariant, CompatibilityConfig } from './compatibility.ts';

export interface CompatibilityPreparationOptions {
  targetId: string;
  sdkTarball: string | null;
  sdkRef: string | null;
  selectedTemplates: string[];
  skipInstall: boolean;
}

export interface CompatibilityRunOptions {
  targetId: string;
  templateId: string | null;
  variantId: string | null;
  mode: string | null;
  playwrightArguments: string[];
}

export function parseCompatibilityPreparationOptions(
  args: string[],
  environment: Record<string, string | undefined> = process.env
): CompatibilityPreparationOptions {
  const [targetId, ...rest] = args;
  if (!targetId || targetId.startsWith('--')) {
    throw new Error(
      'Usage: node scripts/prepare-compatibility-target.ts <target> [--template <id>] [--sdk-tarball <path>] [--sdk-ref <ref>] [--skip-install]'
    );
  }

  const options: CompatibilityPreparationOptions = {
    targetId,
    sdkTarball: null,
    sdkRef: environment.DD_ELECTRON_SDK_GIT_REF?.trim() || null,
    selectedTemplates: [],
    skipInstall: false,
  };
  let sdkRefProvidedByCli = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--skip-install') {
      options.skipInstall = true;
      continue;
    }
    if (argument === '--sdk-tarball') {
      options.sdkTarball = readOptionValue(rest, ++index, argument);
      continue;
    }
    if (argument === '--sdk-ref') {
      options.sdkRef = readOptionValue(rest, ++index, argument);
      sdkRefProvidedByCli = true;
      continue;
    }
    if (argument === '--template') {
      options.selectedTemplates.push(readOptionValue(rest, ++index, argument));
      continue;
    }
    throw new Error(`Unknown option "${argument}".`);
  }
  if (options.sdkTarball && sdkRefProvidedByCli) {
    throw new Error('Options --sdk-tarball and --sdk-ref cannot be used together.');
  }
  if (options.sdkTarball) options.sdkRef = null;
  return options;
}

export function parseCompatibilityRunOptions(args: string[]): CompatibilityRunOptions {
  const [targetId, ...rest] = args;
  if (!targetId || targetId.startsWith('--')) {
    throw new Error(
      'Usage: node scripts/run-compatibility-tests.ts <target> [--template <id>] [--variant <id>] [--mode <mode>] [...playwright arguments]'
    );
  }

  const options: CompatibilityRunOptions = {
    targetId,
    templateId: null,
    variantId: null,
    mode: null,
    playwrightArguments: [],
  };
  let hasPlaywrightProject = false;
  let forwardOnly = false;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (forwardOnly) {
      options.playwrightArguments.push(argument);
      continue;
    }
    if (argument === '--') {
      forwardOnly = true;
      options.playwrightArguments.push(argument);
      continue;
    }

    const template = readRunOption(rest, index, '--template');
    if (template) {
      if (options.templateId !== null) throw new Error('Option --template may only be specified once.');
      options.templateId = template.value;
      index += template.consumedArguments;
      continue;
    }

    const variant = readRunOption(rest, index, '--variant');
    if (variant) {
      if (options.variantId !== null) throw new Error('Option --variant may only be specified once.');
      options.variantId = variant.value;
      index += variant.consumedArguments;
      continue;
    }

    const mode = readRunOption(rest, index, '--mode');
    if (mode) {
      if (options.mode !== null) throw new Error('Option --mode may only be specified once.');
      options.mode = mode.value;
      index += mode.consumedArguments;
      continue;
    }

    if (argument === '--project' || argument.startsWith('--project=')) hasPlaywrightProject = true;
    options.playwrightArguments.push(argument);
  }

  if ((options.variantId !== null || options.mode !== null) && options.templateId === null) {
    throw new Error('Options --variant and --mode require --template.');
  }
  if (hasCompatibilityRunSelector(options) && hasPlaywrightProject) {
    throw new Error('Compatibility selectors cannot be combined with Playwright --project.');
  }

  return options;
}

export function selectCompatibilityPlaywrightProjects(
  config: CompatibilityConfig,
  options: CompatibilityRunOptions
): string[] {
  if (!hasCompatibilityRunSelector(options)) return [];

  const template = config.appTemplates.find(({ id }) => id === options.templateId);
  if (!template) {
    throw new Error(
      `Unknown compatibility app template "${String(options.templateId)}". Available templates: ${config.appTemplates
        .map(({ id }) => id)
        .join(', ')}`
    );
  }

  const variantId = options.variantId ?? 'default';
  const variant = template.variants.find(({ id }) => id === variantId);
  if (!variant) {
    throw new Error(
      `Unknown variant "${variantId}" for compatibility app template "${template.id}". Available variants: ${template.variants
        .map(({ id }) => id)
        .join(', ')}`
    );
  }

  const modes = selectModes(template, variant, options.mode);
  return modes.map((mode) => getCompatibilityPlaywrightProjectName(template, variant, mode));
}

function hasCompatibilityRunSelector(options: CompatibilityRunOptions): boolean {
  return options.templateId !== null || options.variantId !== null || options.mode !== null;
}

function selectModes(template: CompatibilityAppTemplate, variant: CompatibilityAppVariant, mode: string | null) {
  if (mode === null) return variant.modes;
  if (!variant.modes.includes(mode)) {
    throw new Error(
      `Unknown mode "${mode}" for compatibility app template "${template.id}" and variant "${variant.id}". Available modes: ${variant.modes.join(', ')}`
    );
  }
  return [mode];
}

function getCompatibilityPlaywrightProjectName(
  template: CompatibilityAppTemplate,
  variant: CompatibilityAppVariant,
  mode: string
): string {
  if (template.kind === 'e2e') return 'e2e';
  return `${template.id}-${variant.id === 'default' ? '' : `${variant.id}-`}${mode}`;
}

function readRunOption(
  args: string[],
  index: number,
  option: '--template' | '--variant' | '--mode'
): { value: string; consumedArguments: number } | null {
  const argument = args[index];
  if (argument === option) {
    return { value: readOptionValue(args, index + 1, option), consumedArguments: 1 };
  }

  const prefix = `${option}=`;
  if (!argument.startsWith(prefix)) return null;
  const value = argument.slice(prefix.length);
  if (!value) throw new Error(`Option ${option} requires a value.`);
  return { value, consumedArguments: 0 };
}

function readOptionValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`Option ${option} requires a value.`);
  return value;
}
