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
};

module.exports = nextConfig;
