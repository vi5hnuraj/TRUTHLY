import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Newsreader } from "next/font/google";
import "./globals.css";
import Nav from "@/components/layout/nav";
import Footer from "@/components/layout/footer";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: 'swap' });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: 'swap' });
const newsreader = Newsreader({ 
  subsets: ["latin"], 
  variable: "--font-newsreader", 
  style: ['normal', 'italic'],
  display: 'swap'
});

const DESCRIPTION =
  "TRUTHLY turns staked, source-backed reporting into paid intelligence and human-controlled action. Herald verifies, World authorizes, Uniswap checks the market, and Definitive executes protected orders.";

const SITE_URL = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "TRUTHLY — evidence before action",
  description: DESCRIPTION,
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "TRUTHLY — Evidence Before Action",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary",
    title: "TRUTHLY — Evidence Before Action",
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrains.variable} ${newsreader.variable}`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-screen flex flex-col bg-[var(--background)] text-[var(--foreground)] transition-colors duration-300">
        <div className="noise-overlay" />
        <Nav />
        <main className="flex-1 relative z-10">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
