const config = {
  plugins: {
    // 限定前端源码，避免目录依赖快照读取 Rust target 下的大型打包产物。
    // 用 process.cwd() 而非 `new URL("./src", import.meta.url)`：Next 16 构建器
    // 会把后者当成模块请求静态解析，构建期报 "Can't resolve './src'"。
    "@tailwindcss/postcss": {
      base: `${process.cwd()}/src`,
    },
  },
}

export default config
