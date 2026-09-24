import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AISHA — AI Executive",
  description: "Local-first AI executive: supervisor, 16 specialists, real tools, verified results.",
};

const NAV = [
  { href: "/", label: "Console" },
  { href: "/office", label: "3D Office" },
  { href: "/capabilities", label: "Capabilities" },
  { href: "/artifacts", label: "Artifacts & Media" },
  { href: "/security", label: "Security & Audit" },
  { href: "/verification", label: "Verification" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#05070f] text-slate-100 antialiased">
        <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_15%_-10%,rgba(246,192,69,0.12),transparent_55%),radial-gradient(circle_at_85%_0%,rgba(76,201,240,0.10),transparent_50%)]" />
        <div className="relative mx-auto max-w-[1600px] px-4 py-5">
          <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl border border-amber-400/40 bg-amber-400/10 text-lg">👑</span>
              <div>
                <h1 className="text-lg font-semibold tracking-wide text-slate-50">AISHA</h1>
                <p className="text-[11px] text-slate-400">Master supervisor · 16 specialists · verified local execution</p>
              </div>
            </div>
            <nav className="flex flex-wrap gap-1">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-amber-400/40 hover:text-amber-200"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </header>
          {children}
          <footer className="mt-8 border-t border-white/10 pt-3 text-[11px] text-slate-500">
            Every capability is probed live. Unsupported features report UNAVAILABLE with the exact reason instead of pretending to work.
          </footer>
        </div>
      </body>
    </html>
  );
}
