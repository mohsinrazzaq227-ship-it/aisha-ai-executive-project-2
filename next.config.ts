import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / binary-backed packages must be resolved at runtime, not bundled.
  serverExternalPackages: [
    "ffmpeg-static",
    "ffprobe-static",
    "playwright",
    "playwright-core",
    "nodemailer",
    "imapflow",
    "exceljs",
    "mammoth",
    "unpdf",
    "three",
  ],
};

export default nextConfig;
