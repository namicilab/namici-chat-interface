import './globals.css';

export const metadata = {
  title: 'namici-ci',
  description: 'Chat interface for n8n workflows',
  icons: { icon: '/icon-192.png', apple: '/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'namici-ci', statusBarStyle: 'default' as const },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // Draw under the notch and home bar; the CSS pads with safe-area insets.
  viewportFit: 'cover' as const,
  // Android: the on-screen keyboard shrinks the page, so the composer stays visible.
  interactiveWidget: 'resizes-content' as const,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#1b1b29' },
  ],
};

// Applied before first paint, so a dark-mode user never sees a white flash.
const themeScript = `try{var t=localStorage.getItem('namici-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
