import './globals.css';

export const metadata = {
  title: 'namici-ci',
  description: 'Chat interface for n8n workflows',
};

export const viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
