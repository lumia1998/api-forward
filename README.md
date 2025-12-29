# API Forwarder

一个通用的 API 转发服务，支持将请求代理或重定向到目标 API，并可从 JSON 响应中提取图片链接。

## 功能特性

- 🔄 **通用转发** - 将请求转发到任意 API 端点
- 🖼️ **图片提取** - 自动从 JSON 响应中提取图片 URL
- 📁 **分组管理** - 支持将端点按分组归类（默认分组）
- 🎛️ **管理界面** - 可视化配置和管理 API 端点
- 🐳 **Docker 支持** - 支持 Docker 容器化部署
- 💾 **SQLite 存储** - 使用 SQLite 数据库持久化配置

## 快速开始

### 本地运行

```bash
npm install
npm start
```

服务将在 http://localhost:3000 启动，管理界面位于 http://localhost:3000/admin

### Docker 部署

```bash
docker-compose up -d --build
```

服务将在端口 26667 上运行。

## API 端点示例

### 通用转发

```http
GET /forward?url=https://api-endpoint.com
```

转发请求到指定 URL，尝试从响应中提取图片 URL 并重定向。

```http
GET /forward?url=https://api-endpoint.com&field=image
```

通过 `field` 参数指定 JSON 中的图片字段名。

### 二次元图片

```http
GET /anime1
GET /anime2
GET /ba
```

### 三次元图片

```http
GET /baisi
GET /heisi
```

### 表情包

```http
GET /doro
GET /maomao
GET /nailong
```

## 管理界面

访问 `/admin` 可进入管理界面，支持：

- 添加/删除/编辑 API 端点
- 批量操作（删除、移动分组）
- 配置查询参数
- 设置代理/重定向模式

## 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| PORT | 3000 | 服务端口 |
| DB_PATH | ./data/config.db | 数据库路径 |
| ENABLE_FILE_OPERATIONS | true | 启用文件操作 |

## GitHub 仓库

```text
https://github.com/lumia1998/api
```
