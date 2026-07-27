import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";

const WIDTH = 1920;
const HEIGHT = 1080;

let fontCache: Buffer | null = null;

async function loadFont(): Promise<Buffer> {
  if (fontCache) return fontCache;
  // Fonte estática incluída no projeto (ver public/fonts) para não depender de rede em runtime.
  // Formato WOFF (o parser de fontes usado pelo satori/opentype.js lê WOFF nativamente).
  const fontPath = path.join(process.cwd(), "public", "fonts", "Inter-Bold.woff");
  fontCache = await fs.readFile(fontPath);
  return fontCache;
}

interface SlideInput {
  sceneNumber: number;
  totalScenes: number;
  screenText: string;
  projectTitle: string;
  // Caminho local do PNG cartoon gerado pela IA para esta cena
  // (ver src/lib/image-gen.ts). Opcional: se faltar/falhar, o slide é
  // renderizado só com o texto, sem quebrar o vídeo.
  imagePath?: string | null;
}

/**
 * Gera um slide (1920x1080) em PNG para uma cena: ilustração cartoon gerada
 * por IA à esquerda (com base no assunto da cena), texto e progresso à
 * direita/abaixo.
 */
export async function generateSlideImage(input: SlideInput): Promise<string> {
  const font = await loadFont();
  const progress = Math.min(1, input.sceneNumber / input.totalScenes);

  let imageDataUri: string | null = null;
  if (input.imagePath) {
    try {
      const buf = await fs.readFile(input.imagePath);
      imageDataUri = `data:image/png;base64,${buf.toString("base64")}`;
    } catch {
      imageDataUri = null;
    }
  }

  const markup = (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "linear-gradient(135deg, #0f2c4c 0%, #143a63 100%)",
        fontFamily: "Inter",
        position: "relative",
        padding: "0",
      }}
    >
      {/* Elementos decorativos de fundo */}
      <div
        style={{
          position: "absolute",
          left: -140,
          top: -160,
          width: 520,
          height: 520,
          borderRadius: 260,
          background: "rgba(255,255,255,0.04)",
          display: "flex",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: -180,
          bottom: -220,
          width: 620,
          height: 620,
          borderRadius: 310,
          background: "rgba(255,255,255,0.035)",
          display: "flex",
        }}
      />

      {/* Cabeçalho */}
      <div
        style={{
          display: "flex",
          padding: "56px 80px 0 80px",
          color: "#8fb4dd",
          fontSize: 30,
          letterSpacing: 2,
        }}
      >
        {`CENA ${input.sceneNumber} / ${input.totalScenes}`}
      </div>

      {/* Corpo principal: ilustração + texto */}
      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          padding: "24px 100px",
        }}
      >
        <div
          style={{
            display: "flex",
            width: 560,
            height: 560,
            borderRadius: 32,
            overflow: "hidden",
            background: imageDataUri ? "transparent" : "rgba(255,255,255,0.06)",
            flexShrink: 0,
          }}
        >
          {imageDataUri && (
            <img
              src={imageDataUri}
              width={560}
              height={560}
              style={{ objectFit: "cover" }}
            />
          )}
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            paddingLeft: 72,
          }}
        >
          <div
            style={{
              display: "flex",
              color: "#ffffff",
              fontSize: 60,
              fontWeight: 700,
              lineHeight: 1.3,
              maxWidth: 1100,
            }}
          >
            {input.screenText}
          </div>
        </div>
      </div>

      {/* Rodapé: título + barra de progresso */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          padding: "0 80px 56px 80px",
        }}
      >
        <div style={{ display: "flex", color: "#5f88bb", fontSize: 26, marginBottom: 20 }}>
          {input.projectTitle}
        </div>
        <div
          style={{
            display: "flex",
            width: "100%",
            height: 10,
            borderRadius: 5,
            background: "rgba(255,255,255,0.12)",
          }}
        >
          <div
            style={{
              display: "flex",
              width: `${Math.round(progress * 100)}%`,
              height: "100%",
              borderRadius: 5,
              background: "#f4a940",
            }}
          />
        </div>
      </div>
    </div>
  );

  const svg = await satori(markup, {
    width: WIDTH,
    height: HEIGHT,
    fonts: [{ name: "Inter", data: font, weight: 700, style: "normal" }],
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
  });
  const png = resvg.render().asPng();

  const outPath = path.join(os.tmpdir(), `slide-${nanoid(8)}.png`);
  await fs.writeFile(outPath, png);
  return outPath;
}
