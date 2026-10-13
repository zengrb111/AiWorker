/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // pdf-parse 依赖的 pdfjs-dist 是 ESM 包，不能进 webpack 服务端打包，必须在运行时原生 require
    // @napi-rs/canvas 是原生 .node 模块（封面绘制用），同样不能进打包
    serverComponentsExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas"]
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
