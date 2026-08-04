/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `@dsa/shared` ships compiled CommonJS from the workspace; transpiling it keeps
  // Next's bundler happy with the monorepo symlink.
  transpilePackages: ['@dsa/shared'],
  eslint: {
    // Lint is a separate CI step; a lint warning should not fail a production build.
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'assets.leetcode.com' }],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
