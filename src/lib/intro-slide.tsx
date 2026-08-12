import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";
import { detectImageFormat } from "./image-format";

const WIDTH = 1920;
const HEIGHT = 1080;

let fontCache: Buffer | null = null;

async function loadFont(): Promise<Buffer> {
  if (fontCache) return fontCache;
  const fontPath = path.join(process.cwd(), "public", "fonts", "Inter-Bold.woff");
  fontCache = await fs.readFile(fontPath);
  return fontCache;
}

// Caminho onde a logo real da Previna-se deve ficar, se/quando o cliente
// fornecer o arquivo (PNG com fundo transparente, de preferência quadrado
// ou horizontal). Enquanto esse arquivo não existir, a intro cai de volta
// automaticamente pra um logotipo tipográfico ("wordmark") no mesmo estilo
// visual do resto do vídeo (mesma paleta azul/laranja/verde dos slides e
// da mascote) — funciona sem depender do arquivo, mas fica melhor com a
// logo de verdade. Para ativar: salve o arquivo em
// public/branding/logo.png e não precisa mudar nenhum código.
const LOGO_PATH = path.join(process.cwd(), "public", "branding", "logo.png");

async function loadLogoDataUri(): Promise<string | null> {
  try {
    const buf = await fs.readFile(LOGO_PATH);
    const { mime } = detectImageFormat(buf);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null; // arquivo ainda não existe — usa o wordmark tipográfico
  }
}

export interface IntroSlideInput {
  projectTitle: string;
  /** Subtítulo curto, ex.: "Treinamento de Norma Regulamentadora". */
  kicker?: string;
}

/**
 * Gera o frame estático (1920x1080, PNG) usado como base do clipe de
 * abertura do vídeo (ver src/lib/intro.ts, que anima este frame com
 * fade/zoom no FFmpeg). Reaproveita a mesma fonte e a mesma paleta dos
 * slides de cena (src/lib/slides.tsx) para manter identidade visual
 * consistente do início ao fim do vídeo.
 */
export async function generateIntroSlide(input: IntroSlideInput): Promise<string> {
  const font = await loadFont();
  const logoDataUri = await loadLogoDataUri();

  const markup = (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #0f2c4c 0%, #143a63 100%)",
        fontFamily: "Inter",
        position: "relative",
      }}
    >
      {/* Mesmos círculos decorativos sutis dos slides sem imagem, pra
          consistência visual com o resto do vídeo. */}
      <div
        style={{
          position: "absolute",
          left: -140,
          top: -160,
          width: 560,
          height: 560,
          borderRadius: 280,
          background: "rgba(255,255,255,0.04)",
          display: "flex",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: -200,
          bottom: -240,
          width: 680,
          height: 680,
          borderRadius: 340,
          background: "rgba(255,255,255,0.035)",
          display: "flex",
        }}
      />

      {/* Barra de destaque acima da marca */}
      <div
        style={{
          display: "flex",
          width: 96,
          height: 8,
          borderRadius: 4,
          background: "linear-gradient(90deg, #f4a940 0%, #2ecc71 100%)",
          marginBottom: 40,
        }}
      />

      {logoDataUri ? (
        // Cartão branco atrás da logo: a logo enviada já vem com fundo
        // branco embutido (sem alpha), então colocá-la direto sobre o
        // gradiente azul da intro criava uma caixa branca "crua" com corner
        // reto por cima do fundo escuro. Este cartão arredondado com sombra
        // resolve isso — como as duas áreas são brancas, a borda da logo
        // some dentro do cartão e sobra só um card elegante com cantos
        // arredondados flutuando sobre o fundo da marca.
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 460,
            height: 460,
            borderRadius: 48,
            background: "#ffffff",
            boxShadow: "0 24px 60px rgba(0,0,0,0.35)",
            marginBottom: 24,
          }}
        >
          <img
            src={logoDataUri}
            width={380}
            height={380}
            style={{ display: "flex", objectFit: "contain" }}
          />
        </div>
      ) : (
        // Wordmark tipográfico de fallback: "PREVINA" em branco + "-SE" em
        // laranja (cor de destaque usada em todo o resto do vídeo), sem
        // depender de nenhum arquivo de logo.
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 8 }}>
          <div style={{ display: "flex", color: "#ffffff", fontSize: 120, fontWeight: 700, letterSpacing: -2 }}>
            {"PREVINA"}
          </div>
          <div style={{ display: "flex", color: "#f4a940", fontSize: 120, fontWeight: 700, letterSpacing: -2 }}>
            {"-SE"}
          </div>
        </div>
      )}

      <div
        style={{
          display: "flex",
          color: "#c8def4",
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: 4,
          marginTop: 28,
        }}
      >
        {(input.kicker ?? "TREINAMENTO DE NORMA REGULAMENTADORA").toUpperCase()}
      </div>

      <div
        style={{
          display: "flex",
          color: "#ffffff",
          fontSize: 44,
          fontWeight: 700,
          marginTop: 20,
          maxWidth: 1400,
          textAlign: "center",
          lineHeight: 1.3,
        }}
      >
        {input.projectTitle}
      </div>
    </div>
  );

  const svg = await satori(markup, {
    width: WIDTH,
    height: HEIGHT,
    fonts: [{ name: "Inter", data: font, weight: 700, style: "normal" }],
  });

  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } });
  const png = resvg.render().asPng();

  const outPath = path.join(os.tmpdir(), `intro-slide-${nanoid(8)}.png`);
  await fs.writeFile(outPath, png);
  return outPath;
}
