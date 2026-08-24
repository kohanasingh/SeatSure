import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // self-contained server bundle for the Docker runtime image
  output: 'standalone',
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'images.unsplash.com' }],
  },
};

export default nextConfig;
