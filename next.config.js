/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Canvas rendering is all client-side; nothing here should pull in polyfills
  // that would bloat the bundle we measure in PERFORMANCE.md.
  poweredByHeader: false,
};

module.exports = nextConfig;
