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
  },
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/@ffprobe-installer/**/*",
      "./node_modules/ffmpeg-static/**/*",
    ],
  },
};

module.exports = nextConfig;