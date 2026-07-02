import type { ReactNode } from "react";

export const metadata = {
  title: "UP Line",
  description: "Multi-tenant LINE bot platform — Admin Dashboard",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
