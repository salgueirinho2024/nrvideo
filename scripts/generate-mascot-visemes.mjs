// Gera os 8 PNGs de boca (visemas) da mascote via Cloudflare Workers AI
// (mesmo modelo/conta usados em src/lib/image-gen.ts pra ilustração das
// cenas: @cf/black-forest-labs/flux-1-schnell).
//
// POR QUE SEED FIXA: flux-1-schnell é só texto-pra-imagem (sem
// inpainting/edição), então a única forma de manter a "mesma" personagem
// entre os 8 frames é usar SEMPRE a mesma seed + a mesma descrição-base,
// mudando só o trecho que descreve a boca. Não é garantia de pixel-perfect
// (diffusion é sensível a qualquer mudança no prompt mesmo com seed igual),
// mas costuma chegar bem perto — o resto do alinhamento fino (recorte,
// realinhar sobre mouth-closed.png) é manual, do jeito que já foi feito
// pra mouth-open-2.png (ver histórico em src/lib/mascot.tsx).
//
// COMO RODAR:
//   node --env-file=.env.local scripts/generate-mascot-visemes.mjs
//
// Gera todos os 8 em public/mascot/. Pra regenerar só um (se a seed fixa
// não ficar boa nesse frame específico), passe o nome do estado:
//   node --env-file=.env.local scripts/generate-mascot-visemes.mjs wideOpen
//
// Se NENHUM ficar parecido o suficiente entre si, troque MASCOT_SEED por
// outro número e rode tudo de novo — seeds diferentes dão "personagens
// base" diferentes, mas dentro da MESMA seed as 8 bocas tendem a ficar
// coerentes entre si.

import { writeFile, mkdir } from "fs/promises";
import path from "path";

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

// Trocar esse número muda a "cara" gerada pra todos os 8 frames de uma vez
// (mas mantém as 8 entre si o mais parecidas possível, que é o que importa
// aqui). Fixo de propósito — NÃO usar Math.random() como em image-gen.ts.
const MASCOT_SEED = 481516;

const OUT_DIR = path.join(process.cwd(), "public", "mascot");

// Descrição-base da personagem — não muda entre os 8 frames. Mantém tudo
// que define a identidade visual (cabelo, pele, roupa, estilo, fundo,
// enquadramento) fora do trecho de boca, pra dar o máximo de chance da
// seed fixa manter a mesma "pessoa".
const BASE_PROMPT =
  "professional Brazilian female safety technician character, flat vector " +
  "cartoon illustration, front-facing headshot, short straight dark hair, " +
  "light brown skin tone, wearing white hard hat and green safety vest, " +
  "bold clean outlines, simple shapes, bright friendly color palette, " +
  "plain solid light-blue background, centered composition, symmetrical " +
  "face, no text or letters or words in the image";

// Uma entrada por estado de MouthState (src/lib/lipsync/types.ts) — a
// key AQUI precisa bater exatamente com MOUTH_ASSET_FILE em
// src/lib/mascot.tsx.
const VISEMES = [
  {
    key: "closed",
    file: "mouth-closed.png",
    mouth: "mouth fully closed, relaxed neutral lips",
  },
  {
    key: "halfTeeth",
    file: "mouth-half-teeth.png",
    mouth: "mouth slightly open, teeth barely touching, subtle smile",
  },
  {
    key: "chOpen",
    file: "mouth-ch-open.png",
    mouth: "mouth open in rounded square shape, teeth visible",
  },
  {
    key: "wideOpen",
    file: "mouth-wide-open.png",
    mouth: 'mouth wide open, jaw dropped, saying "ah"',
  },
  {
    key: "stretchE",
    file: "mouth-stretch-e.png",
    mouth: 'mouth half open, corners stretched wide, saying "eh"',
  },
  {
    key: "teethLip",
    file: "mouth-teeth-lip.png",
    mouth: 'upper teeth resting on lower lip, saying "f"',
  },
  {
    key: "roundO",
    file: "mouth-round-o.png",
    mouth: 'lips rounded and puckered forward, saying "oh"',
  },
  {
    key: "tongueL",
    file: "mouth-tongue-l.png",
    mouth: "mouth slightly open, tongue tip visible behind upper teeth",
  },
];

async function generateOne(viseme) {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID e/ou CLOUDFLARE_API_TOKEN não configurados. " +
        "Rode com: node --env-file=.env.local scripts/generate-mascot-visemes.mjs"
    );
  }

  const prompt = `${BASE_PROMPT}, ${viseme.mouth}`;
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CLOUDFLARE_MODEL}`;

  console.log(`Gerando "${viseme.key}" (${viseme.file})...`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      seed: MASCOT_SEED,
      steps: 8, // qualidade um degrau acima da ilustração de cena (4), já
      // que aqui é asset reaproveitado em TODOS os vídeos, não descartável.
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `Cloudflare falhou (HTTP ${response.status}) gerando "${viseme.key}": ${errText}`
    );
  }

  const json = await response.json();
  if (!json?.success || !json.result?.image) {
    throw new Error(
      `Cloudflare não retornou imagem pra "${viseme.key}": ${JSON.stringify(json?.errors ?? json)}`
    );
  }

  const buffer = Buffer.from(json.result.image, "base64");
  const outPath = path.join(OUT_DIR, viseme.file);
  await writeFile(outPath, buffer);
  console.log(`  -> salvo em ${outPath}`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const filterKey = process.argv[2];
  const targets = filterKey
    ? VISEMES.filter((v) => v.key === filterKey)
    : VISEMES;

  if (filterKey && targets.length === 0) {
    console.error(
      `Estado "${filterKey}" não existe. Opções: ${VISEMES.map((v) => v.key).join(", ")}`
    );
    process.exit(1);
  }

  for (const viseme of targets) {
    // Sequencial (não Promise.all) de propósito: a Cloudflare no tier free
    // não aceita bem requisições simultâneas na mesma conta, e aqui a
    // ordem/velocidade não importa (roda uma vez, não em runtime).
    await generateOne(viseme);
  }

  console.log(
    "\nPronto. Revise as imagens em public/mascot/ — se alguma boca não " +
      "ficou parecida com as outras (cara diferente, ângulo diferente), " +
      "regenere só ela com:\n" +
      "  node --env-file=.env.local scripts/generate-mascot-visemes.mjs <key>\n" +
      "Depois, se precisar, alinhe manualmente sobre mouth-closed.png " +
      "(mesmo processo de recorte/realinhamento já usado antes)."
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
