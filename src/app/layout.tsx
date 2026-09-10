import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { Suspense } from "react";
import { Header } from "@/components/Header";
import { MotionProvider } from "@/components/MotionProvider";
import { Tour } from "@/components/Tour";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const instrumentSerif = Instrument_Serif({
  variable: "--font-serif",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "The All Freight — Supply Chain Risk Intelligence",
  description:
    "AI-powered supply-chain risk intelligence that predicts disruptions, freight cost increases and shipping delays before they impact your shipments.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <MotionProvider>
          <Header />
          {children}
          {/* Suspense because the tour reads search params (?tour=1) to allow
              replaying it, and that suspends during prerender. */}
          <Suspense fallback={null}>
            <Tour />
          </Suspense>
        </MotionProvider>
      </body>
    </html>
  );
}
