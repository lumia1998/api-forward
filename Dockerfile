FROM node:18-alpine

WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production

# 复制源代码
COPY index.js ./
COPY public ./public/

# 创建数据目录
RUN mkdir -p /app/data

EXPOSE 6667

CMD ["npm", "start"]
