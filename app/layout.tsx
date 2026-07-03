import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Inter, IBM_Plex_Sans_Thai } from "next/font/google";
import "./globals.css";
import ThemeControls from "./theme-controls";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const plexThai = IBM_Plex_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-thai",
  display: "swap",
});

export const metadata: Metadata = {
  title: "UP Line — ระบบ LINE Bot OS สำหรับธุรกิจไทย",
  description:
    "เปลี่ยน LINE OA ให้เป็นผู้ช่วยอัตโนมัติ 24 ชม. — ตรวจสลิป ตอบแชท จัดคิว ปิดการขาย ครบในระบบเดียว เริ่มใช้ได้ทันที ไม่ต้องเขียนโค้ด",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f7fb" },
    { media: "(prefers-color-scheme: dark)", color: "#090d15" },
  ],
};

// Runs before first paint so the theme + font size never flash the wrong value.
const noFlash = `(function(){try{
var t=localStorage.getItem('upl-theme')||'system';
var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme:dark)').matches);
document.documentElement.dataset.theme=d?'dark':'light';
var f=localStorage.getItem('upl-fs')||'md';
document.documentElement.style.setProperty('--fs',f==='sm'?'0.9':f==='lg'?'1.15':'1');
}catch(e){document.documentElement.dataset.theme='light';}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th" className={`${inter.variable} ${plexThai.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
      </head>
      <body>
        {children}
        <ThemeControls />
      </body>
    </html>
  );
}
