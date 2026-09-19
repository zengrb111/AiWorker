/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // pdf-parse 依赖的 pdfjs-dist 是 ESM 包，不能进 webpack 服务端打包，必须在运行时原生 require
    serverComponentsExternalPackages: ["pdf-parse", "pdfjs-dist"]
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com"
      }
    ]
  }
};

export default nextConfig;
