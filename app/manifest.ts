import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'namici-ci — Chat inbox',
    short_name: 'namici',
    description: 'Answer your customers on Telegram, WhatsApp and more when the bot hands over.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    background_color: '#ffffff',
    theme_color: '#ffffff',
    categories: ['business', 'productivity', 'social'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    // Long-press the home-screen icon.
    shortcuts: [
      { name: 'Waiting for a human', short_name: 'Waiting', url: '/?tab=waiting',
        icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
      { name: 'My chats', short_name: 'Mine', url: '/?tab=mine',
        icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
