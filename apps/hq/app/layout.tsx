import type { Metadata, Viewport } from "next";
import "./globals.css";
import { LiveProvider } from "@/lib/live";
import { UndoProvider } from "@/lib/undo";

export const metadata: Metadata = {
  title: "Jarvis HQ",
  description: "One front door to Phil's web of agents.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Jarvis HQ" },
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#050B1E",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" />
      </head>
      <body>
        <LiveProvider><UndoProvider>{children}</UndoProvider></LiveProvider>
      </body>
    </html>
  );
}
