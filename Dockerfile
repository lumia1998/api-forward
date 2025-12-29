FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# 创建数据库目录
RUN mkdir -p /app/data

EXPOSE 6667

CMD ["npm", "start"]
