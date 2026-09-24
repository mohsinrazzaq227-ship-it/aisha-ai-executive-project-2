declare module "ffprobe-static" {
  export const path: string;
  const value: { path: string };
  export default value;
}

declare module "ffmpeg-static" {
  const path: string | null;
  export default path;
}
