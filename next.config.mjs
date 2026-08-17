import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Socket.IO app: effects manage long-lived listeners; skip dev double-mount noise.
  reactStrictMode: false,
  turbopack: { root: __dirname },
};

export default nextConfig;
