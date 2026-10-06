# 局域网快传 —— 零依赖 Node.js 信令服务
FROM node:20-alpine

WORKDIR /app

# 零第三方依赖，无需 npm install，仅拷贝运行所需文件
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

USER node

CMD ["node", "server.js"]
