import type { MetadataRoute } from 'next';

const APP_URL = process.env.APP_URL ?? 'https://pitpals.app';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${APP_URL}/login`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 1,
    },
    {
      url: `${APP_URL}/signup`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.8,
    },
  ];
}
