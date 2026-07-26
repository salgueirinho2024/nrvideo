import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Gerador de Treinamentos NR",
  description:
    "Gere vídeos de treinamento de Normas Regulamentadoras automaticamente a partir do texto da norma.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body
        style={{
          margin: 0,
          fontFamily:
            "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          background: "#0b1220",
          color: "#e8edf6",
          minHeight: "100vh",
        }}
      >
        {children}
      </body>
    </html>
  );
}
