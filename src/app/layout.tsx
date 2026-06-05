import type { Metadata, Viewport } from "next";
import { Archivo, Public_Sans } from "next/font/google";

import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-display",
  display: "swap",
});

const publicSans = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "evidencialo — reportes ciudadanos",
    template: "%s · evidencialo",
  },
  description:
    "Plataforma ciudadana para reportar y visualizar problemas urbanos: baches, basura y alumbrado.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#13171A",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className={`${archivo.variable} ${publicSans.variable}`}>
        {children}
      </body>
    </html>
  );
}
