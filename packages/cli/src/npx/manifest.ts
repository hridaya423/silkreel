export const FORBIDDEN: readonly RegExp[] = [
  /(^|\/)fixtures\//,
  /(^|\/)reference\//,
  /(^|\/)docs\//,
  /(^|\/)cook(-archive)?\//,
  /(^|\/)review\//,
  /(^|\/)exports\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.kicad_pcb$/,
  /\.mp4$/,
  /\.map$/,
  /(^|\/)node_modules\//,
  /(^|\/)\.env/
]

export interface ManifestInput {
  version: string
  root: Record<string, unknown>
  dependencies: Record<string, string>
}

export function packageJson({ version, root, dependencies }: ManifestInput): Record<string, unknown> {
  return {
    name: 'silk-reel',
    version,
    description: root.description,
    keywords: root.keywords,
    repository: root.repository,
    bugs: root.bugs,
    homepage: 'https://silkreel.hridya.tech',
    license: root.license,
    type: 'module',
    bin: { 'silk-reel': './dist/cli.mjs' },
    files: ['dist', 'bundle', 'assets', 'licenses', 'README.md', 'LICENSE'],
    engines: { node: '>=22' },
    dependencies
  }
}
