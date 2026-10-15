/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // pdf-parse 依赖的 pdfjs-dist 是 ESM 包，不能进 webpack 服务端打包，必须在运行时原生 require
    // @napi-rs/canvas 是原生 .node 模块（封面绘制用），同样不能进打包
    serverComponentsExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
    // 启用 instrumentation.ts：服务启动时拉起平台侧定时任务调度器（只做本机 fetch，不引入重模块）
    instrumentationHook: true
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com"
      }
    ]
  },
  webpack: (config, { isServer }) => {
    // 修复 @napi-rs/canvas（原生 .node 二进制）被 webpack 错误打包导致的
    // "Module parse failed: Unexpected character '�' (1:2)" 构建错误。
    // 服务端直接 external 给 Node 运行时 require；客户端不应引用，兜底映射到空模块。
    if (isServer) {
      config.externals.push(({ request }, callback) => {
        if (/^@napi-rs\/canvas/.test(request) || /\.node$/.test(request)) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      });
    } else {
      config.resolve.alias = {
        ...config.resolve.alias,
        "@napi-rs/canvas": false
      };
    }
    return config;
  }
};

export default nextConfig;
