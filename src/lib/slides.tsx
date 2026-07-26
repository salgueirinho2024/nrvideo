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
}

/**
 * Gera um slide (1920x1080) em PNG para uma cena, com o texto principal
 * centralizado, número da cena e título do treinamento no rodapé.
 */
export async function generateSlideImage(input: SlideInput): Promise<string> {
  const font = await loadFont();

  const markup = (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        background: "linear-gradient(135deg, #0f2c4c 0%, #143a63 100%)",
        padding: "80px",
        fontFamily: "Inter",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 60,
          left: 80,
          color: "#8fb4dd",
          fontSize: 32,
          letterSpacing: 2,
          display: "flex",
        }}
      >
        {`CENA ${input.sceneNumber} / ${input.totalScenes}`}
      </div>
      <div
        style={{
          display: "flex",
          color: "#ffffff",
          fontSize: 64,
          fontWeight: 700,
          textAlign: "center",
          lineHeight: 1.3,
          maxWidth: "1500px",
        }}
      >
        {input.screenText}
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 60,
          color: "#5f88bb",
          fontSize: 28,
          display: "flex",
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

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
  });
  const png = resvg.render().asPng();

  const outPath = path.join(os.tmpdir(), `slide-${nanoid(8)}.png`);
  await fs.writeFile(outPath, png);
  return outPath;
}
