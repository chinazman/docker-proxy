# 使用官方 Node.js LTS (Long Term Support) 版本作为基础镜像
FROM node:lts-alpine AS builder

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json (如果存在)
COPY package*.json ./

# 安装项目依赖
# 使用 npm ci 可以更快、更可靠地安装精确的依赖版本
RUN npm ci

# 复制项目源代码
COPY . .

# 如果你的项目有构建步骤 (例如使用 Webpack)
# 请确保 package.json 中有 "build" 脚本，然后取消下面这行的注释
# RUN npm run build

# --- 第二阶段：创建最终的生产镜像 ---
FROM node:lts-alpine

WORKDIR /app

# 从构建阶段复制 node_modules (仅复制生产依赖)
# 首先复制 package.json 以便 npm prune 可以工作
COPY --from=builder /app/package*.json ./
RUN npm prune --production

# 从构建阶段复制构建产物 (如果你的项目有构建步骤)
# COPY --from=builder /app/dist ./dist  # 假设构建产物在 dist 目录

# 复制必要的生产代码
COPY server.js ./
# COPY public ./public # 如果有 public 目录，也需要复制

# 暴露应用程序运行的端口 (请根据你的 server.js 确认或修改)
EXPOSE 3000

# 定义容器启动时运行的命令 (请根据你的 server.js 确认或修改)
CMD [ "node", "server.js" ]