import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/heavy modules must stay outside the bundler: they are executed by the
  // Node server runtime only (frames, media probing, document parsing, encoding).
  serverExternalPackages: ["sharp", "ffmpeg-static", "ffprobe-static", "unpdf", "mammoth", "opentype.js", "fflate", "pg"],
  experimental: {
    // The renderer submits real media to the supervisor (audio, documents, video).
    serverActions: { bodySizeLimit: "120mb" },
  },
};

export default nextConfig;
