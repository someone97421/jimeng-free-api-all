# 构建阶段
FROM node:20-alpine AS builder

# 安装编译 better-sqlite3 所需的工具
RUN apk add --no-cache python3 make g++

WORKDIR /app

# 只复制依赖文件，利用 Docker 缓存
COPY package.json yarn.lock ./

# 安装所有依赖（包括 devDependencies 用于构建）
RUN yarn install --frozen-lockfile --registry https://registry.npmmirror.com/ --ignore-engines

# 复制源代码并构建
COPY . .
RUN yarn run build

# 清理开发依赖，只保留生产依赖
RUN rm -rf node_modules && \
    yarn install --production --frozen-lockfile --registry https://registry.npmmirror.com/ --ignore-engines

# 最终运行镜像 - 使用更小的基础镜像
FROM node:20-alpine

# 安装运行时必需的库（better-sqlite3 需要）
RUN apk add --no-cache libstdc++

WORKDIR /app

# 只复制必要的文件
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/configs ./configs
COPY --from=builder /app/public ./public

# 创建数据目录
RUN mkdir -p /app/data

# 环境变量
ENV NODE_ENV=production
ENV DB_PATH=/app/data/jimeng.db
ENV MEDIA_DIR=/app/data/media
ENV MEDIA_RETENTION_COUNT=50

# 持久化数据卷
VOLUME ["/app/data"]

EXPOSE 8000

CMD ["npm", "start"]
