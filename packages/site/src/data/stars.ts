import { site } from './site'

export const stars: number | null = await fetch(site.repo.replace('github.com', 'api.github.com/repos'), { signal: AbortSignal.timeout(4000) })
  .then((r) => (r.ok ? (r.json() as Promise<{ stargazers_count: number }>) : null))
  .then((j) => j?.stargazers_count ?? null, () => null)
