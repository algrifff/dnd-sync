import type { MetadataRoute } from 'next';

const APP_URL = process.env.APP_URL ?? 'https://pitpals.app';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/login', '/signup'],
        disallow: '/',
      },
    ],
    sitemap: `${APP_URL}/sitemap.xml`,
  };
}
