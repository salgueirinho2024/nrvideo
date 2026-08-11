/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      "fluent-ffmpeg",
      "ffmpeg-static",
      "@ffprobe-installer/ffprobe",
      "@resvg/resvg-js",
      "msedge-tts",
    ],
    outputFileTracingIncludes: {
      "/api/**/*": [
        "./node_modules/@ffprobe-installer/**/*",
        "./node_modules/ffmpeg-static/**/*",
        // Binário do Rhubarb Lip Sync (ver src/lib/lipsync/phoneme-service.ts)
        // + TODOS os arquivos de recurso que ele carrega em runtime a partir
        // do próprio caminho (dicionário fonético, modelo acústico do
        // PocketSphinx etc. em scripts/rhubarb/res/**). O Next.js só
        // detecta e empacota automaticamente arquivos referenciados via
        // import/require — como o Rhubarb é um processo externo chamado
        // via `spawn` e ele mesmo resolve esses arquivos por caminho
        // relativo ao próprio binário, sem essa entrada explícita só o
        // executável ia parar no bundle da Vercel (e foi exatamente o que
        // aconteceu: "Found Rhubarb executable... mas could not find
        // resource file .../res/sphinx/cmudict-en-us.dict").
        "./scripts/rhubarb/**/*",
      ],
    },
  },
};

module.exports = nextConfig;