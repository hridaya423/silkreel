import type { APIRoute } from 'astro'
import { site } from '../data/site'

// every public page; 404 is noindex and left out
const paths = ['/', '/docs/', '/studio/']

export const GET: APIRoute = () => {
  const lastmod = new Date().toISOString().slice(0, 10)
  const urls = paths.map((p) => `  <url><loc>${site.url}${p}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n')
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
}
