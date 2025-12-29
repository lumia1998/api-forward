# API转发服务 - SQLite版本部署说明

## 变更说明

本项目已从MongoDB迁移到SQLite数据库,主要变更:

- ✅ 使用 `better-sqlite3` 替代 `mongodb`
- ✅ 数据库文件存储在 `./data/config.db`
- ✅ Docker部署时数据库文件映射到宿主机
- ✅ 无需外部数据库服务,开箱即用

## 本地部署

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
npm start
```

服务默认运行在 `http://localhost:3000`

数据库文件自动创建在 `./data/config.db`

## Docker部署

### 1. 构建并启动

```bash
docker-compose up -d
```

### 2. 数据持久化

数据库文件映射到宿主机的 `./data` 目录:

```
./data/config.db  ← SQLite数据库文件(持久化)
```

### 3. 停止服务

```bash
docker-compose down
```

**注意**: 即使删除容器,数据库文件仍保留在 `./data` 目录中。

### 4. 重建容器

```bash
docker-compose down
docker-compose up -d --build
```

配置数据不会丢失,因为数据库文件在宿主机上。

## 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PORT` | 3000 | 服务端口 |
| `DB_PATH` | ./data/config.db | SQLite数据库路径 |
| `ENABLE_FILE_OPERATIONS` | true | 是否启用config.json备份 |
| `ADMIN_TOKEN` | admin | 管理界面访问令牌 |

## 配置管理

### 访问管理界面

- 本地: `http://localhost:3000/admin`
- Docker: `http://localhost:6667/admin`

默认令牌: `admin`

### 配置存储

1. **主存储**: SQLite数据库 (`./data/config.db`)
2. **备份**: 本地文件 (`./config.json`,可选)

### 配置优先级

启动时:
```
SQLite数据库 → config.json → 默认空配置
```

保存时:
```
内存 → SQLite数据库 → config.json备份(如果启用)
```

## 数据备份

### 备份数据库

```bash
# 复制数据库文件
cp ./data/config.db ./data/config.db.backup
```

### 恢复数据库

```bash
# 停止服务
docker-compose down

# 恢复数据库文件
cp ./data/config.db.backup ./data/config.db

# 启动服务
docker-compose up -d
```

## 迁移说明

### 从MongoDB迁移

如果您之前使用MongoDB版本,可以通过以下步骤迁移:

1. 从MongoDB导出配置到 `config.json`
2. 将 `config.json` 放在项目根目录
3. 启动新版本,配置会自动导入到SQLite

### 移除的环境变量

以下环境变量已不再使用:
- ~~`MONGODB_URI`~~
- ~~`MONGODB_DB_NAME`~~
- ~~`MONGODB_COLLECTION_NAME`~~

## 故障排除

### 数据库文件权限问题

如果遇到权限错误:

```bash
# Linux/macOS
chmod 666 ./data/config.db

# Docker
docker-compose exec api-forwarder chmod 666 /app/data/config.db
```

### 数据库损坏

如果数据库损坏,删除并重启:

```bash
rm ./data/config.db
docker-compose restart
```

服务会自动创建新数据库并从 `config.json` 导入配置(如果存在)。

## 技术细节

### 数据库结构

```sql
CREATE TABLE config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- 只存储一条记录(id=1)
- `data` 字段存储JSON格式的完整配置
- `updated_at` 记录最后更新时间

### 性能特点

- ✅ 无网络延迟(嵌入式数据库)
- ✅ 同步操作,无需async/await
- ✅ 文件锁机制,支持并发读取
- ✅ 轻量级,无额外依赖

## 常见问题

**Q: 数据库文件可以直接编辑吗?**  
A: 不建议。请使用管理界面或编辑 `config.json` 后重启服务。

**Q: 如何查看数据库内容?**  
A: 使用SQLite客户端:
```bash
sqlite3 ./data/config.db "SELECT * FROM config;"
```

**Q: 支持多实例部署吗?**  
A: SQLite不支持多进程写入。如需多实例,请使用负载均衡+共享存储或改用PostgreSQL/MySQL。

**Q: 数据库文件会变大吗?**  
A: 配置数据很小,通常<1MB。可定期执行 `VACUUM` 优化:
```bash
sqlite3 ./data/config.db "VACUUM;"
```

## 相关链接

- [better-sqlite3 文档](https://github.com/WiseLibs/better-sqlite3)
- [SQLite 官方文档](https://www.sqlite.org/docs.html)
- [项目GitHub](https://github.com/ziyi233/api-foward)
