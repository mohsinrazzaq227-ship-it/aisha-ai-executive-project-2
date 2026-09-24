import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI-EXECUTIVE · Local-First Agent Operating System",
  description:
    "A free/local-first agent operating environment: a Master Supervisor that plans, classifies risk, requests approval and coordinates specialist agents operating a real computer, with a live 3D office driven by backend state.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#040711] text-slate-100 antialiased">{children}</body>
    </html>
  );
}
