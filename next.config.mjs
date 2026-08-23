import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Socket.IO app: effects manage long-lived listeners; skip dev double-mount noise.
  reactStrictMode: false,
  turbopack: { root: __dirname },
  // NOTE: no COOP/COEP headers here. They existed for ffmpeg.wasm multithread
  // (SharedArrayBuffer), but the audio engine runs the single-thread core, so
  // the isolation only served to break the YouTube iframe embed.
};

export default nextConfig;
