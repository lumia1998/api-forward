const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// --- SQLite Configuration ---
// 从环境变量中读取数据库路径,默认为 ./data/config.db
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'config.db');
const dbDir = path.dirname(dbPath);

// 确保数据库目录存在
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`Created database directory: ${dbDir}`);
}

// 初始化SQLite数据库
let db;
try {
    db = new Database(dbPath);
    console.log(`SQLite database initialized at: ${dbPath}`);

    // 创建旧配置表(如果不存在) - 用于兼容和迁移
    db.exec(`
        CREATE TABLE IF NOT EXISTS config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            data TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 创建新的规范化表结构
    db.exec(`
        -- 全局设置表
        CREATE TABLE IF NOT EXISTS global_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            base_tag TEXT DEFAULT '',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- API 端点表
        CREATE TABLE IF NOT EXISTS api_endpoints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            api_key TEXT NOT NULL UNIQUE,
            group_name TEXT DEFAULT '默认分组',
            description TEXT DEFAULT '',
            url TEXT NOT NULL,
            method TEXT DEFAULT 'redirect',
            url_construction TEXT,
            model_name TEXT,
            proxy_image_url_field TEXT,
            proxy_image_url_field_from_param INTEGER DEFAULT 0,
            proxy_fallback_action TEXT DEFAULT 'returnJson',
            type TEXT DEFAULT 'image',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 查询参数表
        CREATE TABLE IF NOT EXISTS query_params (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            endpoint_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            required INTEGER DEFAULT 0,
            default_value TEXT,
            valid_values TEXT,
            sort_order INTEGER DEFAULT 0,
            FOREIGN KEY (endpoint_id) REFERENCES api_endpoints(id) ON DELETE CASCADE
        );

        -- 创建索引
        CREATE INDEX IF NOT EXISTS idx_endpoints_api_key ON api_endpoints(api_key);
        CREATE INDEX IF NOT EXISTS idx_endpoints_group ON api_endpoints(group_name);
        CREATE INDEX IF NOT EXISTS idx_params_endpoint ON query_params(endpoint_id);
    `);

    console.log('Database tables initialized.');

    // 数据迁移：从旧的 JSON 格式迁移到新表
    migrateFromJsonToTables();

} catch (error) {
    console.error('Failed to initialize SQLite database:', error);
    process.exit(1);
}

// 数据迁移函数
function migrateFromJsonToTables() {
    try {
        // 检查是否需要迁移：旧表有数据但新表为空
        const oldConfigRow = db.prepare('SELECT data FROM config WHERE id = 1').get();
        const endpointCount = db.prepare('SELECT COUNT(*) as count FROM api_endpoints').get();

        if (oldConfigRow && oldConfigRow.data && endpointCount.count === 0) {
            console.log('Starting migration from JSON to normalized tables...');

            const oldConfig = JSON.parse(oldConfigRow.data);

            // 使用事务确保数据一致性
            const migrate = db.transaction(() => {
                // 迁移全局设置
                const insertGlobalSettings = db.prepare(`
                    INSERT OR REPLACE INTO global_settings (id, base_tag, updated_at)
                    VALUES (1, ?, datetime('now'))
                `);
                insertGlobalSettings.run(oldConfig.baseTag || '');

                // 迁移 API 端点
                const insertEndpoint = db.prepare(`
                    INSERT INTO api_endpoints (
                        api_key, group_name, description, url, method,
                        url_construction, model_name,
                        proxy_image_url_field, proxy_image_url_field_from_param, proxy_fallback_action,
                        type
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                const insertParam = db.prepare(`
                    INSERT INTO query_params (
                        endpoint_id, name, description, required, default_value, valid_values, sort_order
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                `);

                const apiUrls = oldConfig.apiUrls || {};
                for (const [apiKey, config] of Object.entries(apiUrls)) {
                    // 插入端点
                    const result = insertEndpoint.run(
                        apiKey,
                        config.group || '默认分组',
                        config.description || '',
                        config.url || '',
                        config.method || 'redirect',
                        config.urlConstruction || null,
                        config.modelName || null,
                        config.proxySettings?.imageUrlField || null,
                        config.proxySettings?.imageUrlFieldFromParam ? 1 : 0,
                        config.proxySettings?.fallbackAction || 'returnJson',
                        config.type || 'image'
                    );

                    const endpointId = result.lastInsertRowid;

                    // 插入查询参数
                    const queryParams = config.queryParams || [];
                    queryParams.forEach((param, index) => {
                        insertParam.run(
                            endpointId,
                            param.name || '',
                            param.description || '',
                            param.required ? 1 : 0,
                            param.defaultValue || null,
                            param.validValues ? JSON.stringify(param.validValues) : null,
                            index
                        );
                    });
                }
            });

            migrate();
            console.log(`Migration completed. Migrated ${Object.keys(oldConfig.apiUrls || {}).length} endpoints.`);
        } else if (endpointCount.count > 0) {
            console.log('Data already exists in new tables, skipping migration.');
        } else {
            console.log('No data to migrate.');
        }
    } catch (error) {
        console.error('Migration error:', error);
    }
}

// --- 环境配置 ---
// 是否允许文件操作(默认允许,用于本地部署)
// 设置 ENABLE_FILE_OPERATIONS=false 来禁用文件备份
const enableFileOperations = process.env.ENABLE_FILE_OPERATIONS !== 'false';

// --- 管理界面鉴权配置 ---
// 从环境变量中读取管理员token,如果不存在则使用默认值"admin"
const adminToken = process.env.ADMIN_TOKEN || 'admin';
// 管理界面的cookie名称
const adminCookieName = 'api_forward_admin_token';

// --- Configuration Loading ---
const configPath = path.join(__dirname, 'config.json');
let currentConfig = {};

function loadConfig() {
    try {
        // 从新的规范化表加载配置
        const endpointCount = db.prepare('SELECT COUNT(*) as count FROM api_endpoints').get();

        if (endpointCount.count > 0) {
            // 从新表加载
            console.log('Loading configuration from normalized tables...');

            // 加载全局设置
            const globalSettings = db.prepare('SELECT base_tag FROM global_settings WHERE id = 1').get();
            currentConfig.baseTag = globalSettings?.base_tag || '';

            // 加载所有端点
            const endpoints = db.prepare(`
                SELECT id, api_key, group_name, description, url, method,
                       url_construction, model_name,
                       proxy_image_url_field, proxy_image_url_field_from_param, proxy_fallback_action,
                       type
                FROM api_endpoints
            `).all();

            // 加载所有查询参数
            const allParams = db.prepare(`
                SELECT endpoint_id, name, description, required, default_value, valid_values, sort_order
                FROM query_params
                ORDER BY endpoint_id, sort_order
            `).all();

            // 构建 apiUrls 对象
            currentConfig.apiUrls = {};

            for (const endpoint of endpoints) {
                const queryParams = allParams
                    .filter(p => p.endpoint_id === endpoint.id)
                    .map(p => ({
                        name: p.name,
                        description: p.description || '',
                        required: p.required === 1,
                        defaultValue: p.default_value || undefined,
                        validValues: p.valid_values ? JSON.parse(p.valid_values) : undefined
                    }));

                currentConfig.apiUrls[endpoint.api_key] = {
                    group: endpoint.group_name || '默认分组',
                    description: endpoint.description || '',
                    url: endpoint.url || '',
                    method: endpoint.method || 'redirect',
                    type: endpoint.type || 'image',
                    queryParams: queryParams,
                    proxySettings: {
                        imageUrlField: endpoint.proxy_image_url_field || undefined,
                        imageUrlFieldFromParam: endpoint.proxy_image_url_field_from_param === 1 ? true : undefined,
                        fallbackAction: endpoint.proxy_fallback_action || 'returnJson'
                    }
                };

                // 添加可选字段
                if (endpoint.url_construction) {
                    currentConfig.apiUrls[endpoint.api_key].urlConstruction = endpoint.url_construction;
                }
                if (endpoint.model_name) {
                    currentConfig.apiUrls[endpoint.api_key].modelName = endpoint.model_name;
                }

                // 清理空的 proxySettings
                const ps = currentConfig.apiUrls[endpoint.api_key].proxySettings;
                if (!ps.imageUrlField && !ps.imageUrlFieldFromParam && ps.fallbackAction === 'returnJson') {
                    delete currentConfig.apiUrls[endpoint.api_key].proxySettings.imageUrlField;
                    delete currentConfig.apiUrls[endpoint.api_key].proxySettings.imageUrlFieldFromParam;
                }
            }

            console.log(`Configuration loaded: ${endpoints.length} endpoints.`);

            // 备份到本地文件
            if (enableFileOperations) {
                try {
                    fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), 'utf8');
                    console.log('Configuration backed up to local file.');
                } catch (writeError) {
                    console.error('Error backing up configuration to file:', writeError);
                }
            }
        } else {
            // 尝试从旧的 JSON 表加载（向后兼容）
            const stmt = db.prepare('SELECT data FROM config WHERE id = 1');
            const row = stmt.get();

            if (row && row.data) {
                currentConfig = JSON.parse(row.data);
                console.log('Configuration loaded from legacy JSON table.');
            } else if (fs.existsSync(configPath)) {
                // 从本地文件加载
                const rawData = fs.readFileSync(configPath, 'utf8');
                currentConfig = JSON.parse(rawData);
                console.log('Configuration loaded from local file.');
            } else {
                // 使用默认配置
                console.log('No configuration found. Using default empty configuration.');
                currentConfig = { apiUrls: {}, baseTag: '' };
            }
        }
    } catch (error) {
        console.error('Error loading configuration:', error);
        currentConfig = { apiUrls: {}, baseTag: '' };
    }
}


// --- Utility Functions ---
function getValueByDotNotation(obj, path) {
    if (!path) return undefined;
    const keys = path.split('.');
    let current = obj;
    for (const key of keys) {
        if (current === null || current === undefined || typeof current !== 'object') {
            return undefined;
        }
        current = current[key];
    }
    return current;
}

async function handleProxyRequest(targetUrl, proxySettings = {}, res) {
    try {
        console.log(`[Proxy] Requesting: ${targetUrl}`);
        const response = await axios.get(targetUrl, {
            timeout: 15000, // Increased timeout slightly
            validateStatus: (status) => status >= 200 && status < 500,
        });

        if (response.status >= 400) {
            console.warn(`[Proxy] Target API returned status ${response.status} for ${targetUrl}`);
            return res.status(response.status).json(response.data || { error: `Target API error (Status ${response.status})` });
        }

        let imageUrl = null;
        const fieldToUse = proxySettings.imageUrlField;

        if (fieldToUse && response.data && typeof response.data === 'object') {
            imageUrl = getValueByDotNotation(response.data, fieldToUse);
            if (typeof imageUrl === 'string' && imageUrl.match(/\.(jpeg|jpg|gif|png|webp|bmp|svg)/i)) {
                console.log(`[Proxy] Image URL found via field '${fieldToUse}': ${imageUrl}`);
            } else {
                console.log(`[Proxy] Field '${fieldToUse}' value is not a valid image URL:`, imageUrl);
                imageUrl = null;
            }
        } else if (fieldToUse) {
            console.log(`[Proxy] Could not find/access field '${fieldToUse}' or response is not an object.`);
        }

        if (imageUrl) {
            console.log(`[Proxy] Redirecting to image URL: ${imageUrl}`);
            return res.redirect(imageUrl);
        } else {
            const fallback = proxySettings.fallbackAction || 'returnJson';
            console.log(`[Proxy] Image URL not found/invalid. Fallback: ${fallback}`);
            if (fallback === 'error') {
                return res.status(404).json({ error: 'Could not extract image URL from target API response.', targetUrl: targetUrl });
            } else {
                return res.json(response.data);
            }
        }
    } catch (error) {
        console.error(`[Proxy] Request failed for ${targetUrl}:`, error.message);
        if (error.response) {
            return res.status(error.response.status).json(error.response.data || { error: 'Proxy target returned an error' });
        } else if (error.request) {
            return res.status(504).json({ error: 'Proxy request timed out or failed', targetUrl: targetUrl });
        } else {
            return res.status(500).json({ error: 'Proxy request setup failed', message: error.message });
        }
    }
}

// --- Express App Setup ---
const app = express();
const PORT = process.env.PORT || 3000;


app.use(cors());
app.use(express.json());
// 添加cookie解析中间件
app.use(require('cookie-parser')());
// Serve static files like config.json (for loading in admin page)
// We will handle admin.html explicitly below.
app.use(express.static(path.join(__dirname)));

// --- Configuration Management API ---
app.get('/config', checkAdminAuth, (req, res) => {
    // Send the current in-memory config
    res.json(currentConfig);
});

app.post('/config', checkAdminAuth, (req, res) => {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object' || !newConfig.apiUrls) {
        return res.status(400).json({ error: 'Invalid configuration format.' });
    }
    try {
        // 首先更新内存中的配置
        currentConfig = newConfig;

        // 保存到新的规范化表
        let dbSuccess = false;
        try {
            const saveToNormalizedTables = db.transaction(() => {
                // 更新全局设置
                db.prepare(`
                    INSERT OR REPLACE INTO global_settings (id, base_tag, updated_at)
                    VALUES (1, ?, datetime('now'))
                `).run(newConfig.baseTag || '');

                // 获取现有端点的 api_key 列表
                const existingKeys = db.prepare('SELECT api_key FROM api_endpoints').all().map(r => r.api_key);
                const newKeys = Object.keys(newConfig.apiUrls);

                // 删除不再存在的端点
                const keysToDelete = existingKeys.filter(k => !newKeys.includes(k));
                if (keysToDelete.length > 0) {
                    const deleteEndpoint = db.prepare('DELETE FROM api_endpoints WHERE api_key = ?');
                    for (const key of keysToDelete) {
                        deleteEndpoint.run(key);
                    }
                }

                // 更新或插入端点
                const upsertEndpoint = db.prepare(`
                    INSERT INTO api_endpoints (
                        api_key, group_name, description, url, method,
                        url_construction, model_name,
                        proxy_image_url_field, proxy_image_url_field_from_param, proxy_fallback_action,
                        type,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                    ON CONFLICT(api_key) DO UPDATE SET
                        group_name = excluded.group_name,
                        description = excluded.description,
                        url = excluded.url,
                        method = excluded.method,
                        url_construction = excluded.url_construction,
                        model_name = excluded.model_name,
                        proxy_image_url_field = excluded.proxy_image_url_field,
                        proxy_image_url_field_from_param = excluded.proxy_image_url_field_from_param,
                        proxy_fallback_action = excluded.proxy_fallback_action,
                        type = excluded.type,
                        updated_at = datetime('now')
                `);

                const deleteParams = db.prepare('DELETE FROM query_params WHERE endpoint_id = ?');
                const insertParam = db.prepare(`
                    INSERT INTO query_params (
                        endpoint_id, name, description, required, default_value, valid_values, sort_order
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                `);
                const getEndpointId = db.prepare('SELECT id FROM api_endpoints WHERE api_key = ?');

                for (const [apiKey, config] of Object.entries(newConfig.apiUrls)) {
                    // 插入/更新端点
                    upsertEndpoint.run(
                        apiKey,
                        config.group || '默认分组',
                        config.description || '',
                        config.url || '',
                        config.method || 'redirect',
                        config.urlConstruction || null,
                        config.modelName || null,
                        config.proxySettings?.imageUrlField || null,
                        config.proxySettings?.imageUrlFieldFromParam ? 1 : 0,
                        config.proxySettings?.fallbackAction || 'returnJson',
                        config.type || 'image'
                    );

                    // 获取端点 ID
                    const endpointRow = getEndpointId.get(apiKey);
                    if (endpointRow) {
                        // 删除旧的查询参数
                        deleteParams.run(endpointRow.id);

                        // 插入新的查询参数
                        const queryParams = config.queryParams || [];
                        queryParams.forEach((param, index) => {
                            insertParam.run(
                                endpointRow.id,
                                param.name || '',
                                param.description || '',
                                param.required ? 1 : 0,
                                param.defaultValue || null,
                                param.validValues ? JSON.stringify(param.validValues) : null,
                                index
                            );
                        });
                    }
                }

                // 同时更新旧的 JSON 表（向后兼容）
                db.prepare('INSERT OR REPLACE INTO config (id, data, updated_at) VALUES (1, ?, datetime(\'now\'))').run(JSON.stringify(currentConfig));
            });

            saveToNormalizedTables();
            console.log('Configuration saved to normalized tables.');
            dbSuccess = true;
        } catch (dbError) {
            console.error('Error saving to database:', dbError);
        }

        // 如果允许文件操作,尝试写入本地文件作为备份
        if (enableFileOperations) {
            try {
                fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), 'utf8');
                console.log('Configuration backed up to local file.');

                if (dbSuccess) {
                    return res.json({
                        message: 'Configuration saved to database and backed up to file. Changes are now live.'
                    });
                } else {
                    return res.json({
                        message: 'Configuration saved to file but database update failed. Changes are now live.'
                    });
                }
            } catch (fileError) {
                console.error('Error writing config file:', fileError);
                if (dbSuccess) {
                    return res.json({
                        message: 'Configuration saved to database but backup to file failed. Changes are now live.'
                    });
                } else {
                    return res.status(500).json({
                        error: 'Failed to save configuration to both database and file, but in-memory config updated.'
                    });
                }
            }
        } else {
            // 不允许文件操作,只依赖数据库
            console.log('File operations disabled, skipping file backup.');
            if (dbSuccess) {
                return res.json({
                    message: 'Configuration saved to database. Changes are now live.'
                });
            } else {
                return res.status(500).json({
                    error: 'Failed to save configuration to database, but in-memory config updated.'
                });
            }
        }
    } catch (error) {
        // 捕获内存更新或JSON序列化过程中的潜在错误
        console.error('Error processing new configuration:', error);
        res.status(500).json({ error: 'Failed to process new configuration.' });
    }
});

// --- Wildcard API Route Handler ---
app.get('/:apiKey', async (req, res, next) => {
    const apiKey = req.params.apiKey;
    console.log(`[Router] Received request for /${apiKey}`);

    // Ignore requests for static files handled by express.static
    // Check if the request looks like a file extension common for static assets
    if (apiKey.includes('.') || apiKey === 'favicon.ico') {
        console.log(`[Router] Ignoring likely static file request: /${apiKey}`);
        return next(); // Pass to express.static or 404 handler
    }

    // --- Handle Special System Routes ---
    if (apiKey === 'config') { // Let the dedicated /config route handle this
        console.log(`[Router] Passing /config request to dedicated handler.`);
        return next();
    }
    if (apiKey === 'admin') { // Let the dedicated /admin route handle this
        console.log(`[Router] Passing /admin request to dedicated handler.`);
        return next();
    }
    // Add other potential static files or system routes here if needed

    // --- Lookup API Config ---
    const configEntry = currentConfig.apiUrls ? currentConfig.apiUrls[apiKey] : undefined;

    if (!configEntry || !configEntry.method) {
        console.log(`[Router] No valid configuration found for /${apiKey}. Passing to 404.`);
        return next(); // No config found, let Express handle 404
    }
    console.log(`[Router] Found config for /${apiKey}:`, configEntry);


    // --- Handle Special URL Constructions ---
    if (configEntry.urlConstruction === 'special_forward') {
        console.log(`[Handler /${apiKey}] Using special forward logic.`);
        const targetUrlParam = req.query.url;
        const fieldParam = req.query.field || configEntry.proxySettings?.imageUrlFieldFromParamDefault || 'url';
        if (!targetUrlParam) {
            return res.status(400).json({ error: 'Missing required query parameter: url' });
        }
        const dynamicProxySettings = { ...configEntry.proxySettings, imageUrlField: fieldParam };
        return await handleProxyRequest(targetUrlParam, dynamicProxySettings, res);
    }

    if (configEntry.urlConstruction === 'special_pollinations') {
        console.log(`[Handler /${apiKey}] Using special Pollinations logic.`);
        const tags = req.query.tags;
        if (!tags) {
            return res.status(400).json({ error: 'Missing required query parameter: tags' });
        }
        const baseUrl = configEntry.url; // Use potentially modified base URL
        const modelName = configEntry.modelName;
        const baseTag = currentConfig.baseTag || '';
        const promptUrl = `${baseUrl}${encodeURIComponent(tags)}%2c${baseTag}?&model=${modelName}&nologo=true`;
        console.log(`[Handler /${apiKey}] Redirecting to Pollinations URL: ${promptUrl}`);
        return res.redirect(promptUrl);
    }

    if (configEntry.urlConstruction === 'special_draw_redirect') {
        console.log(`[Handler /${apiKey}] Using special draw redirect logic.`);
        const tags = req.query.tags;
        const modelParamConfig = configEntry.queryParams?.find(p => p.name === 'model');
        const model = req.query.model || modelParamConfig?.defaultValue || 'flux';
        if (!tags) {
            return res.status(400).json({ error: 'Missing required query parameter: tags' });
        }
        const validModels = modelParamConfig?.validValues || ['flux', 'turbo'];
        if (!validModels.includes(model)) {
            return res.status(400).json({ error: `Invalid model parameter. Valid options: ${validModels.join(', ')}` });
        }
        const redirectPath = `/${model}?tags=${encodeURIComponent(tags)}`;
        console.log(`[Handler /${apiKey}] Redirecting /draw to: ${redirectPath}`);
        return res.redirect(redirectPath);
    }

    // --- Generic Handler Logic ---
    console.log(`[Handler /${apiKey}] Using generic logic.`);
    const queryParamsConfig = configEntry.queryParams || [];
    const validatedParams = {};
    const errors = [];

    // 1. Validate Query Parameters
    for (const paramConfig of queryParamsConfig) {
        const paramValue = req.query[paramConfig.name];
        if (paramValue !== undefined) {
            if (paramConfig.validValues && !paramConfig.validValues.includes(paramValue)) {
                errors.push(`Invalid value for parameter '${paramConfig.name}'. Valid: ${paramConfig.validValues.join(', ')}.`);
            } else {
                validatedParams[paramConfig.name] = paramValue;
            }
        } else if (paramConfig.required) {
            errors.push(`Missing required query parameter: ${paramConfig.name}.`);
        } else if (paramConfig.defaultValue !== undefined) {
            validatedParams[paramConfig.name] = paramConfig.defaultValue;
        }
    }

    if (errors.length > 0) {
        return res.status(400).json({ error: 'Invalid query parameters.', details: errors });
    }

    // 2. Construct Target URL
    let targetUrl = configEntry.url; // Use potentially modified base URL
    if (!targetUrl) {
        console.error(`[Handler /${apiKey}] Error: Configuration URL is missing.`);
        return res.status(500).json({ error: "Internal server error: API configuration URL is missing." });
    }
    if (Object.keys(validatedParams).length > 0) {
        try {
            const base = new URL(targetUrl); // Use URL constructor to handle existing params
            Object.entries(validatedParams).forEach(([key, value]) => {
                base.searchParams.append(key, value);
            });
            targetUrl = base.toString();
        } catch (e) {
            // Fallback for potentially invalid base URLs in config, just append
            console.warn(`[Handler /${apiKey}] Could not parse base URL, appending params directly. Error: ${e.message}`);
            const urlSearchParams = new URLSearchParams(validatedParams);
            targetUrl += (targetUrl.includes('?') ? '&' : '?') + urlSearchParams.toString();
        }
    }
    console.log(`[Handler /${apiKey}] Constructed target URL: ${targetUrl}`);

    // 3. Handle Request based on Method
    if (configEntry.method === 'proxy') {
        return await handleProxyRequest(targetUrl, configEntry.proxySettings, res);
    } else { // 'redirect'
        try {
            console.log(`[Handler /${apiKey}] Redirecting to: ${targetUrl}`);
            return res.redirect(targetUrl);
        } catch (error) {
            console.error(`[Handler /${apiKey}] Error during redirect:`, error.message);
            return res.status(500).json({ error: `Failed to redirect for ${apiKey}` });
        }
    }
});


// --- Home Route (API List & Examples) ---
// Needs to be registered *before* the wildcard route
app.get('/', (req, res) => {
    console.log("[Router] Handling request for / (Home Page)");
    // Group endpoints by group name
    const groupedApis = {};
    for (const key in currentConfig.apiUrls) {
        const entry = currentConfig.apiUrls[key];
        const group = entry.group || '默认分组';
        if (!groupedApis[group]) {
            groupedApis[group] = [];
        }
        groupedApis[group].push({ key, ...entry });
    }

    // 为 LLM 提示词准备数据
    const baseURL = `${req.protocol}://${req.get('host')}`;
    const pathFunctions = [];

    // 按组排序的顺序
    const groupOrder = { 'AI绘图': 1, '二次元图片': 2, '三次元图片': 3, '表情包': 4, '默认分组': 99 };

    // 准备所有 API 配置
    const allApis = [];
    for (const key in currentConfig.apiUrls) {
        allApis.push({ key, ...currentConfig.apiUrls[key] });
    }

    // 按组和名称排序
    allApis.sort((a, b) => {
        const orderA = groupOrder[a.group || '默认分组'] || 50;
        const orderB = groupOrder[b.group || '默认分组'] || 50;
        return orderA - orderB || a.key.localeCompare(b.key);
    });

    // 生成路径功能描述
    allApis.forEach(entry => {
        const key = entry.key;
        const group = entry.group || '默认分组';
        const description = entry.description || group;

        // 格式化路径描述
        let pathDesc = '';

        // AI绘图类型需要特殊处理tags参数
        if (group === 'AI绘图') {
            pathDesc = `${description}:/${key}?tags=<tags>`;
        }
        // 其他类型直接使用路径
        else {
            pathDesc = `${description}:/${key}`;
        }

        pathFunctions.push(pathDesc);
    });

    // 生成完整提示词，适合嵌入到 YAML 文件中，每行都有缩进
    const llmPrompt = `    picture_url: |
    {{ 
    根据用户请求，选择合适的图片API路径，生成并返回完整URL。仅输出最终URL，不要添加其他文字。
    基础URL：${baseURL}
    可用路径（不要修改路径格式）：
${pathFunctions.map(path => `    - ${path}`).join('\n')}
    }}`;


    // Sort groups
    const sortedGroups = Object.keys(groupedApis).sort((a, b) => {
        const order = { '通用转发': 1, 'AI绘图': 2, '二次元图片': 3, '三次元图片': 4, '表情包': 5, '默认分组': 99 };
        return (order[a] || 99) - (order[b] || 99);
    });

    // 生成图片卡片HTML
    let apiCardsHtml = '<div class="api-cards-grid">';
    sortedGroups.forEach(groupName => {
        // 添加分组标题
        apiCardsHtml += `<div class="group-section">`;
        apiCardsHtml += `<h3 class="group-title-home">${groupName}</h3>`;
        apiCardsHtml += `<div class="cards-row">`;

        // Sort endpoints within the group
        groupedApis[groupName].sort((a, b) => a.key.localeCompare(b.key));

        groupedApis[groupName].forEach(entry => {
            const key = entry.key;
            const description = entry.description || key;
            const apiUrl = `${baseURL}/${key}`;
            // 统一使用图片加载逻辑，如果是视频会自动切换
            apiCardsHtml += `
            <div class="api-card">
                <div class="api-card-image" onclick="refreshImage(this, '${apiUrl}')">
                    <div class="media-loader">
                        <div class="loader-spinner"></div>
                        <span>加载中...</span>
                    </div>
                    <img src="${apiUrl}?t=${Date.now()}" alt="${description}" loading="lazy" onload="hideLoader(this)" onerror="handleMediaError(this, '${apiUrl}')">
                    <div class="image-overlay">
                        <span class="refresh-hint"><i class="bi bi-arrow-clockwise"></i> 点击刷新</span>
                    </div>
                    <span class="api-badge">${description}</span>
                </div>
                <div class="api-card-info">
                    <p class="api-hint">👆点击图片可刷新预览</p>
                    <p class="api-url">${apiUrl}</p>
                </div>
            </div>
            `;
        });

        apiCardsHtml += `</div></div>`; // Close cards-row and group-section
    });
    apiCardsHtml += '</div>';


    // Construct the full HTML page with Bootstrap 5
    const homeHtmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 转发服务</title>
    <!-- 新 Bootstrap5 核心 CSS 文件 -->
    <link rel="stylesheet" href="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/twitter-bootstrap/5.1.3/css/bootstrap.min.css">
    <!-- Optional: Bootstrap Icons CDN (using cdnjs) -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-icons/1.11.3/font/bootstrap-icons.min.css">
    <!-- Pinyin Library for Emoticon Fetching (using unpkg) -->
    <script src="https://unpkg.com/pinyin-pro@3.26.0/dist/index.js"></script> 
    <style>
        /* v0 Style Adjustments */
        :root {
            --v0-background: #ffffff; /* White background */
            --v0-foreground: #111827; /* Darker gray text (Tailwind gray-900) */
            --v0-muted: #f9fafb; /* Lighter gray for muted backgrounds (Tailwind gray-50) */
            --v0-muted-foreground: #6b7280; /* Medium gray for muted text (Tailwind gray-500) */
            --v0-border: #e5e7eb; /* Light gray border (Tailwind gray-200) */
            --v0-input: #d1d5db; /* Input border (Tailwind gray-300) */
            --v0-primary: #111827; /* Primary color (button bg) - Dark gray */
            --v0-primary-foreground: #ffffff; /* Text on primary button - White */
            --v0-secondary: #f3f4f6; /* Secondary button bg (Tailwind gray-100) */
            --v0-secondary-foreground: #1f2937; /* Text on secondary button (Tailwind gray-800) */
            --v0-card: #ffffff; /* Card background */
            --v0-card-foreground: #111827; /* Card text */
            --v0-radius: 0.5rem; /* Default border radius */
            --v0-radius-lg: 0.75rem; /* Larger radius */
            --v0-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06); /* Subtle shadow */
        }
        body { 
            padding-top: 2rem; 
            padding-bottom: 4rem; 
            background-color: var(--v0-muted); /* Use muted for page background */
            color: var(--v0-foreground);
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"; /* Tailwind default font stack */
        }
        .container { max-width: 1140px; margin: 0 auto; }
        
        /* Card Styles */
        .card { 
            background-color: var(--v0-card);
            color: var(--v0-card-foreground);
            border: 1px solid var(--v0-border); 
            border-radius: var(--v0-radius-lg); /* Larger radius */
            box-shadow: var(--v0-shadow); /* Use shadow variable */
            margin-bottom: 1.5rem;
        }
        .card-header {
            background-color: var(--v0-card); 
            border-bottom: 1px solid var(--v0-border);
            padding: 1rem 1.5rem; /* Increased padding */
            font-weight: 600; /* Bolder header */
            border-radius: var(--v0-radius-lg) var(--v0-radius-lg) 0 0; /* Match card radius */
        }
        .card-body { padding: 1.5rem; }
        .card-footer { 
            background-color: var(--v0-muted); 
            border-top: 1px solid var(--v0-border);
            color: var(--v0-muted-foreground);
            padding: 0.75rem 1.5rem; /* Match header padding */
            border-radius: 0 0 var(--v0-radius-lg) var(--v0-radius-lg); /* Match card radius */
        }
        .card img { 
            max-height: 180px; /* Slightly smaller max height */
            object-fit: contain; 
            border-radius: calc(var(--v0-radius-lg) - 1px) calc(var(--v0-radius-lg) - 1px) 0 0; /* Match card radius */
        }
        
        /* Button Styles */
        .btn {
             border-radius: var(--v0-radius);
             padding: 0.5rem 1rem; /* Slightly smaller padding */
             font-size: 0.875rem; /* Smaller font size */
             font-weight: 500;
             transition: background-color 0.15s ease-in-out, border-color 0.15s ease-in-out, color 0.15s ease-in-out, box-shadow 0.15s ease-in-out;
             border: 1px solid transparent; /* Ensure border exists for consistent sizing */
             line-height: 1.25rem; /* Ensure consistent height */
        }
        .btn:focus-visible { /* Modern focus ring */
             outline: 2px solid transparent;
             outline-offset: 2px;
             box-shadow: 0 0 0 2px var(--v0-background), 0 0 0 4px var(--v0-primary);
        }
        .btn-primary {
            background-color: var(--v0-primary);
            border-color: var(--v0-primary);
            color: var(--v0-primary-foreground);
        }
        .btn-primary:hover {
            background-color: #374151; /* Tailwind gray-700 */
            border-color: #374151;
            color: var(--v0-primary-foreground);
        }
        .btn-outline-primary {
             color: var(--v0-primary);
             border-color: var(--v0-input); /* Use input border color */
             background-color: var(--v0-background);
        }
         .btn-outline-primary:hover {
             background-color: var(--v0-secondary);
             color: var(--v0-secondary-foreground);
             border-color: var(--v0-input);
         }
         .btn-success { /* For copy button success state */
             background-color: #22c55e; /* Tailwind green-500 */
             border-color: #22c55e;
             color: #ffffff;
         }
         .btn-success:hover {
             background-color: #16a34a; /* Tailwind green-600 */
             border-color: #16a34a;
             color: #ffffff;
         }
        .btn-lg { padding: 0.75rem 1.5rem; font-size: 1rem; }
        .btn-sm { padding: 0.25rem 0.75rem; font-size: 0.75rem; border-radius: calc(var(--v0-radius) - 0.125rem); }

        /* Table Styles */
        .table { 
            border-color: var(--v0-border); 
            margin-bottom: 0; 
        }
        .table th, .table td { 
            vertical-align: middle; 
            padding: 0.75rem 1rem; /* Adjusted padding */
            border-top: 1px solid var(--v0-border);
            font-size: 0.875rem; /* Smaller font */
            line-height: 1.25rem;
        }
        .table thead th {
            border-bottom: 1px solid var(--v0-border); /* Standard border */
            background-color: var(--v0-muted); 
            color: var(--v0-muted-foreground); /* Muted text for header */
            font-weight: 500;
            text-transform: uppercase; /* Uppercase headers */
            letter-spacing: 0.05em; /* Slight letter spacing */
            font-size: 0.75rem; /* Smaller header font */
        }
        .table-striped > tbody > tr:nth-of-type(odd) > * {
             background-color: var(--v0-muted); /* Use muted for striping */
             color: var(--v0-foreground);
        }
        .table-hover > tbody > tr:hover > * {
             background-color: #f3f4f6; /* Tailwind gray-100 */
             color: var(--v0-foreground);
        }
        .table-bordered { border: 1px solid var(--v0-border); }
        .table-bordered th, .table-bordered td { border: 1px solid var(--v0-border); }
        .table-responsive { margin-bottom: 1rem; border: 1px solid var(--v0-border); border-radius: var(--v0-radius); overflow: hidden; } /* Add border/radius to responsive container */

        /* Code & Pre Styles */
        code { 
            font-size: 0.875em; 
            color: var(--v0-foreground); 
            background-color: var(--v0-secondary); /* Use secondary bg */
            padding: 0.2em 0.4em;
            border-radius: 0.25rem; /* Slightly smaller radius */
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; /* Monospace font */
        }
        pre {
            background-color: var(--v0-secondary); /* Use secondary bg */
            border: 1px solid var(--v0-border);
            border-radius: var(--v0-radius);
            padding: 1rem;
            color: var(--v0-foreground);
            white-space: pre-wrap; 
            word-break: break-word; 
            font-size: 0.875rem;
            line-height: 1.5;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; /* Monospace font */
        }
        
        /* Alert Styles */
        .alert {
             border-radius: var(--v0-radius);
             border: 1px solid transparent;
             padding: 0.75rem 1rem; /* Adjusted padding */
             font-size: 0.875rem;
        }
        .alert-info {
             color: #0c5460; /* Keep original colors for now */
             background-color: #d1ecf1;
             border-color: #bee5eb;
        }
        .alert-info .bi { 
             margin-right: 0.5rem;
             vertical-align: text-bottom; /* Align icon better */
        }

        /* Other Styles */
        .p-5 { padding: 3rem !important; } /* Increased padding */
        .py-5 { padding-top: 3rem !important; padding-bottom: 3rem !important; }
        .mb-4 { margin-bottom: 1.5rem !important; }
        .mt-4 { margin-top: 1.5rem !important; }
        .mt-3 { margin-top: 1rem !important; }
        .mt-2 { margin-top: 0.5rem !important; }
        .bg-light { background-color: var(--v0-card) !important; border: 1px solid var(--v0-border); } /* Use card bg and add border */
        .rounded-3 { border-radius: var(--v0-radius-lg) !important; } /* Use large radius */
        .text-muted { color: var(--v0-muted-foreground) !important; }
        .fw-bold { font-weight: 600 !important; } 
        .display-5 { font-size: 2.25rem; font-weight: 700; } /* Slightly smaller, bolder */
        .fs-4 { font-size: 1.125rem; line-height: 1.75rem; } /* Adjusted size and line height */
        h1, h2, h3, h5 { font-weight: 600; color: var(--v0-foreground); }
        h2.h5 { font-size: 1rem; font-weight: 600; } /* Adjust size for card headers */
        hr.my-1 { margin-top: 0.25rem !important; margin-bottom: 0.25rem !important; opacity: 0.1;}
        .badge { border-radius: 0.375rem; padding: 0.25em 0.6em; font-weight: 500; font-size: 0.75rem; } /* Smaller badge */
        .bg-primary { background-color: var(--v0-primary) !important; color: var(--v0-primary-foreground); }
        .bg-secondary { background-color: var(--v0-secondary) !important; color: var(--v0-secondary-foreground); }

        /* API Cards Grid Styles */
        .api-cards-grid { margin-top: 2rem; }
        .group-section { margin-bottom: 2rem; }
        .group-title-home { font-size: 1.25rem; font-weight: 600; color: var(--v0-foreground); margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid var(--v0-border); }
        .cards-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1.5rem; }
        .api-card { background: var(--v0-card); border: 1px solid var(--v0-border); border-radius: var(--v0-radius-lg); overflow: hidden; box-shadow: var(--v0-shadow); transition: transform 0.2s, box-shadow 0.2s; }
        .api-card:hover { transform: translateY(-4px); box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1); }
        .api-card-image { position: relative; height: 200px; overflow: hidden; cursor: pointer; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .api-card-image img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s, opacity 0.3s; }
        .api-card-image:hover img { transform: scale(1.05); }
        .image-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.3s; }
        .api-card-image:hover .image-overlay { opacity: 1; }
        .refresh-hint { color: #fff; font-size: 0.875rem; font-weight: 500; padding: 0.5rem 1rem; background: rgba(0,0,0,0.5); border-radius: var(--v0-radius); }
        .api-badge { position: absolute; bottom: 0.75rem; right: 0.75rem; background: #ffd700; color: #000; font-size: 0.75rem; font-weight: 600; padding: 0.25rem 0.5rem; border-radius: 0.25rem; }
        .api-card-info { padding: 1rem; }
        .api-hint { font-size: 0.8rem; color: var(--v0-muted-foreground); margin-bottom: 0.5rem; }
        .api-url { font-size: 0.8rem; color: #3b82f6; word-break: break-all; margin: 0; }
        .api-url:hover { text-decoration: underline; }
        /* Loading Spinner 样式 */
        .media-loader {
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
            font-size: 0.875rem;
            z-index: 1;
        }
        .media-loader.hidden { display: none; }
        .loader-spinner {
            width: 40px;
            height: 40px;
            border: 3px solid rgba(255,255,255,0.3);
            border-top-color: #fff;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 0.5rem;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <main class="container">
        <div class="p-5 mb-4 bg-light rounded-3">
          <div class="container-fluid py-5">
            <h1 class="display-5 fw-bold">API 转发服务</h1>
            <p class="col-md-8 fs-4">使用此服务转发 API 请求。所有配置均可通过管理页面动态修改。</p>
             <a href="/admin" class="btn btn-primary btn-lg" role="button"><i class="bi bi-gear-fill"></i> 前往管理页面</a>
          </div>
        </div>
        
        <!-- LLM 提示词生成卡片 -->
        <div class="card mb-4">
            <div class="card-header d-flex justify-content-between align-items-center">
                <h2 class="h5 mb-0">LLM 提示词</h2>
                <button id="copy-prompt-btn" class="btn btn-sm btn-outline-primary"><i class="bi bi-clipboard"></i> 复制</button>
            </div>
            <div class="card-body">
                <div class="alert alert-info mb-2">
                    <small><i class="bi bi-info-circle"></i> 以下是自动生成的 LLM 提示词，适合嵌入到 YAML 文件中。每行都有适当的缩进，复制后可直接粘贴到配置文件中。</small>
                </div>
                <pre id="llm-prompt" class="bg-light p-3 rounded" style="white-space: pre-wrap; word-break: break-word; font-size: 0.875rem;">${llmPrompt}</pre>
            </div>
        </div>

        <!-- API 图片卡片展示 -->
        ${apiCardsHtml}


    </main>
    <!-- Popper.js -->
    <script src="https://lf6-cdn-tos.bytecdntp.com/cdn/expire-1-M/popper.js/2.11.2/umd/popper.min.js"></script>
    <!-- Bootstrap 5 JS -->
    <script src="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/twitter-bootstrap/5.1.3/js/bootstrap.min.js"></script>
    
    <!-- 复制按钮脚本 -->
    <script>
        document.addEventListener('DOMContentLoaded', function() {
            const promptElement = document.getElementById('llm-prompt');
            const copyButton = document.getElementById('copy-prompt-btn');
            
            if (promptElement && copyButton) {
                // 复制按钮功能
                copyButton.addEventListener('click', () => {
                    const textToCopy = promptElement.textContent;
                    navigator.clipboard.writeText(textToCopy).then(() => {
                        // 显示复制成功提示
                        const originalText = copyButton.innerHTML;
                        copyButton.innerHTML = '<i class="bi bi-check"></i> 已复制';
                        copyButton.classList.remove('btn-outline-primary');
                        copyButton.classList.add('btn-success');
                        
                        setTimeout(() => {
                            copyButton.innerHTML = originalText;
                            copyButton.classList.remove('btn-success');
                            copyButton.classList.add('btn-outline-primary');
                        }, 2000);
                    }).catch(err => {
                        console.error('复制失败:', err);
                        alert('复制失败，请手动复制');
                    });
                });
            }
        });
        
        // 图片加载成功时隐藏 loader
        function hideLoader(mediaElement) {
            const loader = mediaElement.parentNode.querySelector('.media-loader');
            if (loader) {
                loader.classList.add('hidden');
            }
        }

        // 处理图片加载错误，尝试切换为视频
        function handleMediaError(imgElement, apiUrl) {
            // 防止重复处理
            if (imgElement.dataset.hasError) return;
            imgElement.dataset.hasError = 'true';

            console.log('Image load failed, trying video for:', apiUrl);

            const parent = imgElement.parentNode;
            const loader = parent.querySelector('.media-loader');

            // 创建 video 元素
            const video = document.createElement('video');
            video.src = apiUrl + '?t=' + Date.now();
            video.autoplay = true;
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            
            // 复制 img 的样式类
            video.style.width = '100%';
            video.style.height = '100%';
            video.style.objectFit = 'cover';
            
            // 视频加载成功后隐藏 loader
            video.onloadeddata = function() {
                console.log('Video loaded successfully for:', apiUrl);
                if (loader) {
                    loader.classList.add('hidden');
                }
            };
            
            // 替换 img 元素
            parent.replaceChild(video, imgElement);
            
            // 如果视频也加载失败，显示错误占位图并隐藏 loader
            video.onerror = function() {
                console.log('Video also failed for:', apiUrl);
                if (loader) {
                    loader.classList.add('hidden');
                }
                const errorImg = document.createElement('img');
                errorImg.src = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22150%22><rect fill=%22%23f0f0f0%22 width=%22200%22 height=%22150%22/><text fill=%22%23999%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22>加载失败</text></svg>';
                errorImg.style.width = '100%';
                errorImg.style.height = '100%';
                errorImg.style.objectFit = 'cover';
                parent.replaceChild(errorImg, video);
            };
        }

        // 点击刷新图片/视频函数
        function refreshImage(container, apiUrl) {
            const media = container.querySelector('img, video');
            if (media) {
                media.style.opacity = '0.5';
                const newSrc = apiUrl + '?t=' + Date.now();
                
                if (media.tagName === 'IMG') {
                    // 重置错误标记，以便再次失败时能重新尝试转视频
                    delete media.dataset.hasError;
                    
                    const newImg = new Image();
                    newImg.onload = function() {
                        media.src = newSrc;
                        media.style.opacity = '1';
                    };
                    newImg.onerror = function() {
                        // 如果刷新时图片加载失败，直接触发 handleMediaError
                        handleMediaError(media, apiUrl);
                        // 注意：handleMediaError 会替换元素，所以不需要这里恢复 opacity
                    };
                    newImg.src = newSrc;
                } else if (media.tagName === 'VIDEO') {
                    media.src = newSrc;
                    // 视频加载开始即恢复透明度
                    media.onloadeddata = function() {
                        media.style.opacity = '1';
                    };
                    media.onerror = function() {
                        // 视频刷新失败，可能变回图片了？或者网络问题。保持视频容器，或者可以尝试切回图片检测
                        media.style.opacity = '1'; 
                    };
                }
            }
        }
    </script>
</body>
</html>
`;
    res.setHeader('Content-Type', 'text/html');
    res.send(homeHtmlContent);
});

// --- Admin Interface Routes ---
// 验证管理员权限的中间件
function checkAdminAuth(req, res, next) {
    // 检查cookie中的token
    const tokenFromCookie = req.cookies?.[adminCookieName];

    // 如果有效token，允许访问
    if (tokenFromCookie === adminToken) {
        return next();
    }

    // 如果是API请求，返回401状态码
    if (req.path.startsWith('/config') || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // 否则重定向到登录页面
    res.redirect('/admin-login');
}

// 登录页面
app.get('/admin-login', (req, res) => {
    console.log("[Router] Handling request for /admin-login");
    const loginHtmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 转发管理登录</title>
    <link rel="stylesheet" href="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/twitter-bootstrap/5.1.3/css/bootstrap.min.css">
    <style>
        /* v0 Style Adjustments */
        :root {
            --v0-background: #ffffff; /* White background */
            --v0-foreground: #09090b; /* Near black text */
            --v0-muted: #f9fafb; /* Lighter gray (Tailwind gray-50) */
            --v0-muted-foreground: #6b7280; /* Medium gray (Tailwind gray-500) */
            --v0-border: #e5e7eb; /* Light gray border (Tailwind gray-200) */
            --v0-input: #d1d5db; /* Input border (Tailwind gray-300) */
            --v0-primary: #111827; /* Dark gray (Tailwind gray-900) */
            --v0-primary-foreground: #ffffff; /* White */
            --v0-destructive: #ef4444; /* Red (Tailwind red-500) */
            --v0-destructive-foreground: #ffffff; /* White */
            --v0-card: #ffffff; /* Card background */
            --v0-card-foreground: #111827; /* Card text */
            --v0-radius: 0.5rem; /* Default border radius */
            --v0-radius-lg: 0.75rem; /* Larger radius */
            --v0-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06); /* Subtle shadow */
        }
        body { 
            background-color: var(--v0-muted); 
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"; /* Tailwind default font stack */
            color: var(--v0-foreground);
        }
        .login-container {
            max-width: 400px;
            width: 100%;
            padding: 2.5rem; 
            background-color: var(--v0-card);
            border-radius: var(--v0-radius-lg); /* Larger radius */
            border: 1px solid var(--v0-border);
            box-shadow: var(--v0-shadow); /* Use shadow variable */
        }
        .login-header {
            text-align: center;
            margin-bottom: 2rem;
        }
        .login-header h2 {
            font-size: 1.5rem; /* Slightly smaller heading */
            font-weight: 600;
            color: var(--v0-foreground);
            margin-bottom: 0.5rem;
        }
        .login-header p {
            color: var(--v0-muted-foreground);
            font-size: 0.875rem; /* Smaller text */
        }
        .error-message {
            color: var(--v0-destructive); 
            background-color: #fef2f2; /* Tailwind red-50 */
            border: 1px solid #fca5a5; /* Tailwind red-300 */
            border-radius: var(--v0-radius); /* Standard radius */
            padding: 0.75rem 1rem;
            margin-bottom: 1.5rem;
            font-size: 0.875rem;
            display: none; 
        }
        .form-label {
            font-weight: 500;
            margin-bottom: 0.5rem;
            font-size: 0.875rem;
            color: var(--v0-foreground);
        }
        .form-control {
            display: block;
            width: 100%;
            padding: 0.5rem 0.75rem; /* Adjusted padding */
            font-size: 0.875rem; /* Smaller font */
            font-weight: 400;
            line-height: 1.5;
            color: var(--v0-foreground);
            background-color: var(--v0-background);
            background-clip: padding-box;
            border: 1px solid var(--v0-input);
            appearance: none;
            border-radius: var(--v0-radius);
            transition: border-color .15s ease-in-out,box-shadow .15s ease-in-out;
        }
        .form-control:focus {
            color: var(--v0-foreground);
            background-color: var(--v0-background);
            border-color: var(--v0-primary); 
            outline: 0;
            box-shadow: 0 0 0 2px var(--v0-background), 0 0 0 4px var(--v0-primary); /* Modern focus ring */
        }
        .btn {
             border-radius: var(--v0-radius);
             padding: 0.5rem 1rem; /* Adjusted padding */
             font-size: 0.875rem; /* Smaller font */
             font-weight: 500;
             transition: background-color 0.15s ease-in-out, border-color 0.15s ease-in-out, color 0.15s ease-in-out, box-shadow 0.15s ease-in-out;
             display: inline-flex; 
             align-items: center;
             justify-content: center;
             line-height: 1.25rem; /* Consistent height */
             border: 1px solid transparent;
        }
         .btn:focus-visible { /* Modern focus ring */
             outline: 2px solid transparent;
             outline-offset: 2px;
             box-shadow: 0 0 0 2px var(--v0-background), 0 0 0 4px var(--v0-primary);
        }
        .btn-primary {
            background-color: var(--v0-primary);
            border-color: var(--v0-primary);
            color: var(--v0-primary-foreground);
        }
        .btn-primary:hover {
            background-color: #374151; /* Tailwind gray-700 */
            border-color: #374151;
            color: var(--v0-primary-foreground);
        }
        .w-100 { width: 100% !important; }
        .mb-3 { margin-bottom: 1rem !important; } /* Reduced margin */
    </style>
</head>
<body>
    <div class="login-container">
        <div class="login-header">
            <h2>API 转发管理登录</h2>
            <p class="text-muted">请输入管理员令牌进行登录</p>
        </div>
        <div id="error-message" class="error-message"></div>
        <form id="login-form">
            <div class="mb-3">
                <label for="token" class="form-label">管理令牌</label>
                <input type="password" class="form-control" id="token" required>
            </div>
            <button type="submit" class="btn btn-primary w-100">登录</button>
        </form>
    </div>

    <script>
        const form = document.getElementById('login-form');
        const errorMessage = document.getElementById('error-message');
        
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const token = document.getElementById('token').value;
            
            try {
                const response = await fetch('/admin-auth', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ token })
                });
                
                if (response.ok) {
                    // 登录成功，重定向到管理页面
                    window.location.href = '/admin';
                } else {
                    // 显示错误信息
                    const data = await response.json();
                    errorMessage.textContent = data.error || '登录失败，请检查令牌是否正确';
                    errorMessage.style.display = 'block';
                }
            } catch (error) {
                errorMessage.textContent = '登录请求失败，请重试';
                errorMessage.style.display = 'block';
                console.error('Login error:', error);
            }
        });
    </script>
</body>
</html>
    `;
    res.setHeader('Content-Type', 'text/html');
    res.send(loginHtmlContent);
});

// 处理登录请求
app.post('/admin-auth', express.json(), (req, res) => {
    const { token } = req.body;

    if (token === adminToken) {
        // 设置cookie，有效期24小时
        res.cookie(adminCookieName, token, {
            maxAge: 24 * 60 * 60 * 1000, // 24小时
            httpOnly: true,
            sameSite: 'strict'
        });
        res.json({ success: true });
    } else {
        res.status(401).json({ error: '无效的管理令牌' });
    }
});

// 管理员退出
app.get('/admin-logout', (req, res) => {
    res.clearCookie(adminCookieName);
    res.redirect('/admin-login');
});

// 管理界面（需要验证）
app.get('/admin', checkAdminAuth, (req, res) => {
    console.log("[Router] Handling request for /admin (Admin Interface)");
    const adminHtmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 转发配置管理</title>
    <!-- 新 Bootstrap5 核心 CSS 文件 -->
    <link rel="stylesheet" href="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/twitter-bootstrap/5.1.3/css/bootstrap.min.css">
    <!-- Optional: Bootstrap Icons CDN (using cdnjs) -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-icons/1.11.3/font/bootstrap-icons.min.css">
    <!-- Pinyin Library for Emoticon Fetching (using unpkg) -->
    <script src="https://unpkg.com/pinyin-pro@3.26.0/dist/index.js"></script>
    <style>
        /* v0 Style Adjustments */
        :root {
            --v0-background: #ffffff; /* White background */
            --v0-foreground: #09090b; /* Near black text */
            --v0-muted: #f8fafc; /* Very light slate */
            --v0-muted-foreground: #64748b; /* Slate-500 */
            --v0-border: #e2e8f0; /* Slate-200 */
            --v0-input: #cbd5e1; /* Slate-300 */
            --v0-primary: #0f172a; /* Slate-900 */
            --v0-primary-foreground: #ffffff; /* White */
            --v0-secondary: #f1f5f9; /* Slate-100 */
            --v0-secondary-foreground: #0f172a; /* Slate-900 */
            --v0-destructive: #ef4444; /* Red-500 */
            --v0-destructive-foreground: #ffffff;
            --v0-success: #22c55e;
            --v0-success-foreground: #ffffff;
            --v0-card: #ffffff;
            --v0-card-foreground: #020617; /* Slate-950 */
            --v0-radius: 0.5rem;
            --v0-radius-lg: 0.75rem;
            --v0-shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
            --v0-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
            --v0-shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
        }
        body { 
            background-color: var(--v0-muted); 
            padding-top: 3rem; 
            padding-bottom: 5rem; 
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            color: var(--v0-foreground);
            line-height: 1.5;
        }
        .container { 
            max-width: 1000px; /* Limit width for cleaner look */
            margin: 0 auto;    /* Center */
            padding: 0 1.5rem;
        }
        
        /* Typography */
        h1, h2, h3, h4, h5 { font-weight: 600; letter-spacing: -0.025em; color: var(--v0-primary); }
        h1 { font-size: 1.875rem; line-height: 2.25rem; }
        
        /* Card Styles */
        .card { 
            background-color: var(--v0-card);
            color: var(--v0-card-foreground);
            border: 1px solid var(--v0-border); 
            border-radius: var(--v0-radius-lg); 
            box-shadow: var(--v0-shadow); /* Modern shadow */
            margin-bottom: 2rem; 
            overflow: hidden; /* Ensure rounded corners clip content */
            transition: box-shadow 0.2s, transform 0.2s;
        }
        .card:hover { box-shadow: var(--v0-shadow-lg); } /* Lift effect on hover */

        .card-header { 
            background-color: #fff; /* Clean white header */
            border-bottom: 1px solid var(--v0-border);
            padding: 1.25rem 1.5rem; 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
        }
        .card-body { padding: 1.5rem; }

        /* API Key Input in Header */
        .api-key-input { 
            font-weight: 600; 
            border: 1px solid transparent; 
            border-radius: var(--v0-radius);
            padding: 0.25rem 0.5rem; 
            background: var(--v0-secondary); 
            color: var(--v0-primary); 
            margin-left: 0.5rem; 
            width: auto; 
            min-width: 150px;
            max-width: 300px;
            transition: all 0.2s;
            font-size: 1rem;
        }
        .api-key-input:focus { 
            outline: none; 
            background: #fff;
            border-color: var(--v0-input);
            box-shadow: 0 0 0 2px var(--v0-muted);
        }
        
        /* Form Elements */
        .form-label {
            font-weight: 500;
            font-size: 0.875rem;
            color: var(--v0-foreground);
            margin-bottom: 0.375rem; /* Adjusted margin */
        }
        .col-form-label { padding-top: calc(0.5rem + 1px); padding-bottom: calc(0.5rem + 1px); font-size: 0.875rem; } 
        .form-control, .form-select {
            display: block;
            width: 100%;
            padding: 0.5rem 0.75rem; 
            font-size: 0.875rem; 
            font-weight: 400;
            line-height: 1.25rem; /* Consistent line height */
            color: var(--v0-foreground);
            background-color: var(--v0-background);
            background-clip: padding-box;
            border: 1px solid var(--v0-input);
            appearance: none;
            border-radius: var(--v0-radius); 
            transition: border-color .15s ease-in-out,box-shadow .15s ease-in-out;
        }
        textarea.form-control { min-height: calc(1.25rem * 3 + 1rem + 2px); } /* Adjust based on line height */
        .form-control:focus, .form-select:focus {
            color: var(--v0-foreground);
            background-color: var(--v0-background);
            border-color: var(--v0-primary);
            outline: 0;
            box-shadow: 0 0 0 2px var(--v0-background), 0 0 0 4px var(--v0-primary); /* Modern focus ring */
        }
        .form-control[readonly] {
             background-color: var(--v0-muted);
             opacity: 0.7; /* Slightly faded */
             cursor: not-allowed;
        }
        .form-check-input {
             width: 1em; /* Standard size */
             height: 1em;
             margin-top: 0.25em; /* Adjust alignment */
             border-radius: 0.25em;
             border: 1px solid var(--v0-input);
        }
        .form-check-input:focus {
             border-color: var(--v0-primary);
             outline: 0;
             box-shadow: 0 0 0 2px var(--v0-background), 0 0 0 4px var(--v0-primary);
        }
        .form-check-input:checked {
             background-color: var(--v0-primary);
             border-color: var(--v0-primary);
        }
        .form-switch .form-check-input {
             width: 2em; /* Standard switch width */
             margin-left: -2.5em;
             background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='-4 -4 8 8'%3e%3ccircle r='3' fill='rgba(107, 114, 128, 0.25)'/%3e%3c/svg%3e"); /* Gray-500 at 25% opacity */
             background-position: left center;
             border-radius: 2em;
             transition: background-position .15s ease-in-out;
        }
        .form-switch .form-check-input:focus {
             background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='-4 -4 8 8'%3e%3ccircle r='3' fill='rgba(107, 114, 128, 0.25)'/%3e%3c/svg%3e");
        }
        .form-switch .form-check-input:checked {
             background-position: right center;
             background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='-4 -4 8 8'%3e%3ccircle r='3' fill='%23fff'/%3e%3c/svg%3e"); 
        }
        .form-check-label { font-size: 0.875rem; padding-left: 0.5em; } /* Add padding for switch */
        
        /* Buttons */
        .btn {
             border-radius: var(--v0-radius);
             padding: 0.5rem 1rem; 
             font-size: 0.875rem;
             font-weight: 500;
             transition: background-color 0.15s ease-in-out, border-color 0.15s ease-in-out, color 0.15s ease-in-out, opacity 0.15s ease-in-out, box-shadow 0.15s ease-in-out;
             display: inline-flex;
             align-items: center;
             justify-content: center;
             gap: 0.375rem; /* Reduced gap */
             line-height: 1.25rem; /* Consistent height */
             border: 1px solid transparent;
        }
         .btn:focus-visible { /* Modern focus ring */
             outline: 2px solid transparent;
             outline-offset: 2px;
             box-shadow: 0 0 0 2px var(--v0-background), 0 0 0 4px var(--v0-primary);
        }
        .btn-primary {
            background-color: var(--v0-primary); border-color: var(--v0-primary); color: var(--v0-primary-foreground);
        }
        .btn-primary:hover { background-color: #374151; border-color: #374151; color: var(--v0-primary-foreground); } /* Tailwind gray-700 */
        .btn-primary:disabled { background-color: var(--v0-primary); border-color: var(--v0-primary); color: var(--v0-primary-foreground); opacity: 0.5; cursor: not-allowed; }
        
        .btn-success { 
            background-color: var(--v0-success); border-color: var(--v0-success); color: var(--v0-success-foreground);
        }
        .btn-success:hover { background-color: #16a34a; border-color: #16a34a; } /* Tailwind green-600 */
        
        .btn-danger { 
            background-color: var(--v0-destructive); border-color: var(--v0-destructive); color: var(--v0-destructive-foreground);
        }
        .btn-danger:hover { background-color: #dc2626; border-color: #dc2626; } /* Tailwind red-600 */
        
        .btn-outline-secondary { 
             color: var(--v0-secondary-foreground);
             border-color: var(--v0-input);
             background-color: var(--v0-background);
        }
         .btn-outline-secondary:hover {
             background-color: var(--v0-secondary);
             border-color: var(--v0-input);
             color: var(--v0-secondary-foreground);
         }
        
        .btn-sm { padding: 0.25rem 0.75rem; font-size: 0.75rem; border-radius: var(--v0-radius-sm); gap: 0.25rem; }
        .btn-lg { padding: 0.625rem 1.25rem; font-size: 1rem; } /* Adjusted large button */
        .save-button .spinner-border { width: 1em; height: 1em; border-width: .15em; } /* Thinner spinner */

        /* Specific Sections */
        .proxy-settings, .query-params { 
            margin-top: 1.5rem; 
            padding-top: 1.5rem; 
            border-top: 1px solid var(--v0-border); 
        }
        .proxy-settings h5, .query-params h5 {
             font-size: 0.875rem; /* Smaller heading */
             font-weight: 600;
             margin-bottom: 1rem;
             color: var(--v0-foreground);
             text-transform: uppercase; /* Uppercase subheadings */
             letter-spacing: 0.05em;
        }
        .param-item { 
            border: 1px solid var(--v0-border); 
            padding: 1rem; 
            margin-bottom: 1rem; 
            border-radius: var(--v0-radius); 
            background-color: var(--v0-muted); /* Muted background for param items */
            position: relative; 
        }
        .param-item .remove-param-button { 
            position: absolute; 
            top: 0.5rem; 
            right: 0.5rem; 
            padding: 0.1rem 0.4rem; 
            background-color: var(--v0-background); /* Ensure visibility on muted bg */
            border-color: var(--v0-border);
            color: var(--v0-destructive);
        }
         .param-item .remove-param-button:hover {
             background-color: var(--v0-destructive);
             border-color: var(--v0-destructive);
             color: var(--v0-destructive-foreground);
         }
        .global-setting-item { 
            padding: 1rem 1.5rem; 
            border: 1px solid var(--v0-border); 
            background-color: var(--v0-muted); 
            border-radius: var(--v0-radius); 
            margin-bottom: 1.5rem; 
        }
        .group-title { 
            margin-top: 2rem; /* Reduced top margin */
            margin-bottom: 1rem; 
            font-size: 1.125rem; /* Adjusted group title size */
            font-weight: 600;
            color: var(--v0-muted-foreground); 
            border-bottom: 1px solid var(--v0-border); 
            padding-bottom: 0.5rem; 
        }
        .group-title:first-of-type { margin-top: 0; } 

        /* Alert/Message Styles */
        #message { 
            margin-top: 1.5rem; 
            border-radius: var(--v0-radius);
            padding: 0.75rem 1rem; /* Adjusted padding */
            font-size: 0.875rem;
        }
        .alert-success {
             color: #0f5132; /* Tailwind green-800 */
             background-color: #d1fae5; /* Tailwind green-100 */
             border-color: #a7f3d0; /* Tailwind green-200 */
        }
        .alert-danger {
             color: #991b1b; /* Tailwind red-800 */
             background-color: #fee2e2; /* Tailwind red-100 */
             border-color: #fca5a5; /* Tailwind red-300 */
        }
        
        /* Tooltip */
        .tooltip-icon { cursor: help; color: var(--v0-muted-foreground); margin-left: 0.25rem; vertical-align: middle; }
        .tooltip-inner { background-color: var(--v0-primary); color: var(--v0-primary-foreground); font-size: 0.75rem; padding: 0.375rem 0.625rem; border-radius: var(--v0-radius-sm); box-shadow: var(--v0-shadow); }
        .tooltip.bs-tooltip-top .tooltip-arrow::before { border-top-color: var(--v0-primary); }
        .tooltip.bs-tooltip-bottom .tooltip-arrow::before { border-bottom-color: var(--v0-primary); }
        .tooltip.bs-tooltip-start .tooltip-arrow::before { border-left-color: var(--v0-primary); }
        .tooltip.bs-tooltip-end .tooltip-arrow::before { border-right-color: var(--v0-primary); }

        /* Utility Overrides */
        .mb-4 { margin-bottom: 1.5rem !important; }
        .mt-4 { margin-top: 1.5rem !important; }
        .text-muted { color: var(--v0-muted-foreground) !important; }
        .text-sm-end { text-align: right !important; } 
        .h3 { font-size: 1.25rem; font-weight: 600; } /* Smaller main heading */
        .spinner-border { color: var(--v0-primary); }
        .spinner-border-sm { width: 1rem; height: 1rem; border-width: 0.15em; }

        /* Table View Styles */
        .view-toggle-btn.active { background-color: var(--v0-primary); color: var(--v0-primary-foreground); }
        .table-view-container { display: none; }
        .table-view-container.active { display: block; }
        .card-view-container { display: block; }
        .card-view-container.hidden { display: none; }
        
        .api-table { width: 100%; border-collapse: collapse; background: var(--v0-card); border-radius: var(--v0-radius-lg); overflow: hidden; box-shadow: var(--v0-shadow); table-layout: fixed; }
        .api-table th { background: var(--v0-muted); color: var(--v0-muted-foreground); font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.75rem 0.5rem; text-align: left; border-bottom: 1px solid var(--v0-border); white-space: nowrap; }
        .api-table td { padding: 0.5rem 0.5rem; border-bottom: 1px solid var(--v0-border); font-size: 0.875rem; vertical-align: middle; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .api-table tr:hover { background-color: var(--v0-muted); }
        .api-table .editable-cell { display: block; cursor: text; padding: 0.375rem 0.5rem; border-radius: var(--v0-radius); transition: background-color 0.15s; min-width: 60px; background-color: #f8f9fa; border: 1px solid #dee2e6; overflow: hidden; text-overflow: ellipsis; }
        .api-table .editable-cell:hover { background-color: #e9ecef; border-color: #ced4da; }
        .api-table .editable-cell:focus { outline: none; background-color: #fff; box-shadow: 0 0 0 2px var(--v0-primary); border-color: var(--v0-primary); }
        .api-table .url-cell { max-width: 250px; }
        .api-table .action-cell { white-space: nowrap; text-align: center; }
        .api-table .group-row { background-color: var(--v0-secondary); }
        .api-table .group-row td { font-weight: 600; color: var(--v0-primary); padding: 0.5rem 1rem; }
        .api-table select.form-select-sm { font-size: 0.8rem; padding: 0.25rem 1.5rem 0.25rem 0.5rem; }
        .add-row-btn { width: 100%; padding: 0.75rem; margin-top: 0.5rem; border: 2px dashed var(--v0-border); background: transparent; color: var(--v0-muted-foreground); border-radius: var(--v0-radius); cursor: pointer; transition: all 0.15s; }
        .add-row-btn:hover { border-color: var(--v0-primary); color: var(--v0-primary); background: var(--v0-muted); }
    </style>
</head>
<body>
    <main class="container">
        <div class="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
            <h1 class="h3 mb-0">API 转发配置管理</h1>
             <div class="d-flex gap-2 flex-wrap align-items-center">
                 <!-- View Toggle Buttons -->
                 <div class="btn-group me-2" role="group" aria-label="视图切换">
                     <button type="button" class="btn btn-outline-secondary view-toggle-btn" id="table-view-btn" onclick="switchView('table')" title="表格视图"><i class="bi bi-table"></i></button>
                     <button type="button" class="btn btn-outline-secondary view-toggle-btn active" id="card-view-btn" onclick="switchView('card')" title="卡片视图"><i class="bi bi-card-text"></i></button>
                 </div>
                 <button type="button" class="btn btn-secondary" onclick="addNewGroup()"><i class="bi bi-folder-plus"></i> 添加新分组</button>
                 <button type="button" class="btn btn-success add-endpoint-button" onclick="addApiEndpoint()"><i class="bi bi-plus-lg"></i> 添加新 API 端点</button>
                 <a href="/admin-logout" class="btn btn-outline-secondary"><i class="bi bi-box-arrow-right"></i> 退出登录</a>
             </div>
        </div>

        <p class="text-muted mb-4">在这里修改、添加或删除 API 转发规则。点击“在线拉取表情包”可自动添加常用表情包 API。所有更改将在点击下方“保存所有配置”按钮后**立即生效**。</p>

        <!-- Batch Actions Section -->
        <div id="batch-actions-section" class="card mb-4" style="display: none;">
            <div class="card-body d-flex flex-wrap align-items-center gap-3">
                 <div class="form-check">
                     <input class="form-check-input" type="checkbox" value="" id="select-all-checkbox" onchange="toggleSelectAll(this.checked)">
                     <label class="form-check-label" for="select-all-checkbox">
                         全选/取消
                     </label>
                 </div>
                 <button id="batch-delete-button" type="button" class="btn btn-danger btn-sm" onclick="batchDeleteEndpoints()" disabled>
                     <i class="bi bi-trash"></i> 批量删除 (<span id="selected-count">0</span>)
                 </button>
                 <div class="input-group input-group-sm" style="max-width: 300px;">
                     <label class="input-group-text" for="batch-move-group-select">移动到分组:</label>
                     <select class="form-select" id="batch-move-group-select" disabled>
                         <option value="" selected disabled>选择目标分组...</option>
                         {/* Group options will be populated by JS */}
                     </select>
                     <button id="batch-move-button" class="btn btn-outline-primary" type="button" onclick="batchMoveGroup()" disabled>
                         <i class="bi bi-folder-symlink"></i> 移动
                     </button>
                 </div>
             </div>
        </div>

        <!-- Global Settings Card Removed -->

        <form id="config-form">
            <!-- Table View Container -->
            <div id="table-view-container" class="table-view-container">
                <div class="table-responsive">
                    <table class="api-table" id="api-table">
                        <thead>
                            <tr>
                                <th style="width: 40px;"><input type="checkbox" class="form-check-input" id="table-select-all" onchange="toggleTableSelectAll(this.checked)"></th>
                                <th style="width: 140px;">端点路径</th>
                                <th style="width: 80px;">分组</th>
                                <th style="width: 120px;">描述</th>
                                <th>目标 URL</th>
                                <th style="width: 70px;">类型</th>
                                <th style="width: 80px;">处理方式</th>
                                <th style="width: 80px;">操作</th>
                            </tr>
                        </thead>
                        <tbody id="api-table-body">
                        </tbody>
                    </table>
                </div>
                <button type="button" class="add-row-btn" onclick="addTableRow()"><i class="bi bi-plus-lg"></i> 添加新行</button>
            </div>

            <!-- Card View Container (Original) -->
            <div id="card-view-container" class="card-view-container">
                <div id="api-configs-container">
                    <!-- Initial Loading Indicator -->
                     <div class="text-center">
                        <div class="spinner-border text-primary" role="status">
                            <span class="visually-hidden">正在加载配置...</span>
                        </div>
                        <p class="mt-2">正在加载配置...</p>
                    </div>
                </div>
            </div>

            <!-- Global settings placeholder removed -->


            <button type="submit" class="btn btn-primary w-100 btn-lg save-button mt-4">
                 <i class="bi bi-save"></i> 保存所有配置
            </button>
        </form>
        <div id="message" class="alert mt-4" role="alert" style="display: none;"></div>
    </main>

    <!-- Bootstrap 5 JS Bundle CDN -->
    <script src="https://lf6-cdn-tos.bytecdntp.com/cdn/expire-1-M/popper.js/2.11.2/umd/popper.min.js"></script>
    <script src="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/twitter-bootstrap/5.1.3/js/bootstrap.min.js"></script>
    <script>
        const form = document.getElementById('config-form');
        const apiConfigsContainer = document.getElementById('api-configs-container');
        // baseTag input removed
        const messageDiv = document.getElementById('message');
        let currentConfigData = { apiUrls: {} };
        let bootstrapTooltipList = [];
        let currentView = 'card'; // 'card' or 'table'

        // === View Switching Functions ===
        function switchView(view) {
            currentView = view;
            const tableViewBtn = document.getElementById('table-view-btn');
            const cardViewBtn = document.getElementById('card-view-btn');
            const tableContainer = document.getElementById('table-view-container');
            const cardContainer = document.getElementById('card-view-container');
            
            if (view === 'table') {
                tableViewBtn.classList.add('active');
                cardViewBtn.classList.remove('active');
                tableContainer.classList.add('active');
                cardContainer.classList.add('hidden');
                renderTableView();
            } else {
                cardViewBtn.classList.add('active');
                tableViewBtn.classList.remove('active');
                tableContainer.classList.remove('active');
                cardContainer.classList.remove('hidden');
                renderConfig(); // Refresh cards from currentConfigData
            }
        }

        function renderTableView() {
            const tbody = document.getElementById('api-table-body');
            tbody.innerHTML = '';
            
            const apiUrls = currentConfigData.apiUrls || {};
            const groupedEndpoints = {};
            
            // Group endpoints
            for (const apiKey in apiUrls) {
                const entry = apiUrls[apiKey];
                const group = entry.group || '默认分组';
                if (!groupedEndpoints[group]) { groupedEndpoints[group] = []; }
                groupedEndpoints[group].push({ key: apiKey, config: entry });
            }
            
            // Sort groups
            const sortedGroups = Object.keys(groupedEndpoints).sort((a, b) => {
                const order = {'通用转发': 1, 'AI绘图': 2, '二次元图片': 3, '三次元图片': 4, '表情包': 5, '696898': 6, '默认分组': 99};
                return (order[a] || 50) - (order[b] || 50);
            });
            
            sortedGroups.forEach(groupName => {
                // Sort endpoints within group
                groupedEndpoints[groupName].sort((a, b) => a.key.localeCompare(b.key));
                
                // Add group header row
                const groupRow = document.createElement('tr');
                groupRow.className = 'group-row';
                groupRow.innerHTML = '<td colspan=\"8\"><i class=\"bi bi-folder\"></i> ' + groupName + ' (' + groupedEndpoints[groupName].length + ')</td>';
                tbody.appendChild(groupRow);
                
                // Add endpoint rows
                groupedEndpoints[groupName].forEach(item => {
                    const row = createTableRow(item.key, item.config);
                    tbody.appendChild(row);
                });
            });
            
            if (Object.keys(apiUrls).length === 0) {
                const emptyRow = document.createElement('tr');
                emptyRow.innerHTML = '<td colspan="7" class="text-center text-muted py-4">暂无 API 端点，点击下方"添加新行"开始</td>';
                tbody.appendChild(emptyRow);
            }
        }

        function createTableRow(apiKey, config) {
            const row = document.createElement('tr');
            row.setAttribute('data-api-key', apiKey);
            
            const typeImageSelected = (!config.type || config.type === 'image') ? 'selected' : '';
            const typeVideoSelected = config.type === 'video' ? 'selected' : '';
            const methodRedirectSelected = config.method === 'redirect' ? 'selected' : '';
            const methodProxySelected = config.method === 'proxy' ? 'selected' : '';
            
            row.innerHTML = '<td><input type="checkbox" class="form-check-input table-row-checkbox" value="' + apiKey + '" onchange="updateTableSelectState()"></td>' +
                '<td><span class="editable-cell" contenteditable="true" data-field="key" data-original="' + apiKey + '">' + apiKey + '</span></td>' +
                '<td><span class="editable-cell" contenteditable="true" data-field="group">' + (config.group || '默认分组') + '</span></td>' +
                '<td><span class="editable-cell" contenteditable="true" data-field="description">' + (config.description || '') + '</span></td>' +
                '<td class="url-cell" title="' + (config.url || '') + '"><span class="editable-cell" contenteditable="true" data-field="url">' + (config.url || '') + '</span></td>' +
                '<td><select class="form-select form-select-sm" data-field="type" onchange="markRowChanged(this)">' +
                    '<option value="image" ' + typeImageSelected + '>图片</option>' +
                    '<option value="video" ' + typeVideoSelected + '>视频</option>' +
                '</select></td>' +
                '<td><select class="form-select form-select-sm" data-field="method" onchange="markRowChanged(this)">' +
                    '<option value="redirect" ' + methodRedirectSelected + '>重定向</option>' +
                    '<option value="proxy" ' + methodProxySelected + '>代理</option>' +
                '</select></td>' +
                '<td class="action-cell">' +
                    '<button type="button" class="btn btn-outline-primary btn-sm me-1" onclick="editInCardView(\\\'' + apiKey + '\\\')" title="详细编辑"><i class="bi bi-pencil"></i></button>' +
                    '<button type="button" class="btn btn-outline-danger btn-sm" onclick="deleteTableRow(this)" title="删除"><i class="bi bi-trash"></i></button>' +
                '</td>';
            
            // Add blur event listeners for editable cells
            row.querySelectorAll('.editable-cell').forEach(function(cell) {
                cell.addEventListener('blur', function() {
                    syncTableCellToConfig(this);
                });
                cell.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        this.blur();
                    }
                });
            });
            
            return row;
        }

        function syncTableCellToConfig(cell) {
            const row = cell.closest('tr');
            const originalKey = row.getAttribute('data-api-key');
            const field = cell.getAttribute('data-field');
            const newValue = cell.textContent.trim();
            
            if (field === 'key') {
                const sanitizedKey = sanitizeApiKey(newValue);
                if (sanitizedKey !== newValue) {
                    cell.textContent = sanitizedKey;
                }
                if (sanitizedKey && sanitizedKey !== originalKey) {
                    // Rename the key in config
                    if (currentConfigData.apiUrls[originalKey]) {
                        currentConfigData.apiUrls[sanitizedKey] = currentConfigData.apiUrls[originalKey];
                        delete currentConfigData.apiUrls[originalKey];
                        row.setAttribute('data-api-key', sanitizedKey);
                        row.querySelector('.table-row-checkbox').value = sanitizedKey;
                    }
                }
            } else if (currentConfigData.apiUrls[originalKey]) {
                currentConfigData.apiUrls[originalKey][field] = newValue;
            }
        }

        function markRowChanged(element) {
            const row = element.closest('tr');
            const apiKey = row.getAttribute('data-api-key');
            const field = element.getAttribute('data-field');
            const value = element.value;
            
            if (currentConfigData.apiUrls[apiKey]) {
                currentConfigData.apiUrls[apiKey][field] = value;
            }
        }

        function addTableRow() {
            const newKey = 'new_' + Date.now();
            currentConfigData.apiUrls[newKey] = {
                group: '默认分组',
                description: '',
                url: '',
                type: 'image',
                method: 'redirect',
                queryParams: [],
                proxySettings: {}
            };
            // Append new row directly to tbody instead of full re-render
            const tbody = document.getElementById('api-table-body');
            const newRowConfig = currentConfigData.apiUrls[newKey];
            const row = createTableRow(newKey, newRowConfig);
            row.style.backgroundColor = '#fffce6'; // Highlight new row
            tbody.appendChild(row);
            // Focus on the new row's key cell
            const keyCell = row.querySelector('.editable-cell[data-field="key"]');
            if (keyCell) {
                keyCell.focus();
                keyCell.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const range = document.createRange();
                range.selectNodeContents(keyCell);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }

        function deleteTableRow(button) {
            const row = button.closest('tr');
            const apiKey = row.getAttribute('data-api-key');
            delete currentConfigData.apiUrls[apiKey];
            row.remove();
            showMessage('端点 /' + apiKey + ' 已删除。点击"保存所有配置"以确认。', 'success');
            handleCheckboxChange();
        }

        function editInCardView(apiKey) {
            // Switch to card view and scroll to the specific card
            switchView('card');
            setTimeout(function() {
                const card = document.querySelector('.card[data-api-key="' + apiKey + '"]');
                if (card) {
                    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    card.style.boxShadow = '0 0 0 3px var(--v0-primary)';
                    setTimeout(function() { card.style.boxShadow = ''; }, 2000);
                }
            }, 100);
        }

        function toggleTableSelectAll(checked) {
            document.querySelectorAll('.table-row-checkbox').forEach(cb => { cb.checked = checked; });
            updateTableSelectState();
        }

        function updateTableSelectState() {
            const allCheckboxes = document.querySelectorAll('.table-row-checkbox');
            const checkedCount = document.querySelectorAll('.table-row-checkbox:checked').length;
            const selectAll = document.getElementById('table-select-all');
            
            if (allCheckboxes.length > 0 && checkedCount === allCheckboxes.length) {
                selectAll.checked = true;
                selectAll.indeterminate = false;
            } else if (checkedCount > 0) {
                selectAll.checked = false;
                selectAll.indeterminate = true;
            } else {
                selectAll.checked = false;
                selectAll.indeterminate = false;
            }
            handleCheckboxChange();
            // Sync card view checkboxes if needed? For now just update batch actions
        }


        function showMessage(text, type = 'success') {
            const msgDiv = document.getElementById('message');
            if (msgDiv) {
                msgDiv.textContent = text;
                msgDiv.className = \`alert alert-\${type === 'success' ? 'success' : 'danger'} mt-4\`;
                msgDiv.style.display = 'block';
                msgDiv.setAttribute('role', 'alert');
                // msgDiv.scrollIntoView({ behavior: 'smooth', block: 'end' }); // Disable auto-scroll
                setTimeout(() => {
                     msgDiv.style.display = 'none';
                }, 7000);
            }
        }

        function sanitizeApiKey(key) {
            // Remove any characters that are not letters, numbers, hyphens, or underscores
            let sanitized = key.replace(/[^a-zA-Z0-9-_]/g, ''); 
            // Allow keys to start with numbers
            return sanitized;
        }

        function initializeTooltips(container) {
            if (typeof bootstrap === 'undefined' || typeof bootstrap.Tooltip === 'undefined') {
                console.warn('Bootstrap Tooltip component not ready yet, skipping initialization.');
                return;
            }
            const tooltipTriggerList = [].slice.call(container.querySelectorAll('[data-bs-toggle="tooltip"]'));
            const newTooltips = tooltipTriggerList.map(function (tooltipTriggerEl) {
                const existingTooltip = bootstrap.Tooltip.getInstance(tooltipTriggerEl);
                if (existingTooltip) { existingTooltip.dispose(); }
                try { return new bootstrap.Tooltip(tooltipTriggerEl); }
                catch (e) { console.error("Failed to initialize tooltip:", tooltipTriggerEl, e); return null; }
            }).filter(Boolean);
            bootstrapTooltipList = bootstrapTooltipList.concat(newTooltips);
        }

        function disposeAllTooltips() {
             if (typeof bootstrap !== 'undefined' && bootstrap.Tooltip) {
                 bootstrapTooltipList.forEach(tooltip => { try { tooltip.dispose(); } catch (e) { console.warn("Error disposing tooltip:", e); } });
             }
             bootstrapTooltipList = [];
        }

        // Remove API endpoint function for card view
        function removeApiEndpoint(card) {
            if (!card) return;
            const apiKey = card.getAttribute('data-api-key');
            delete currentConfigData.apiUrls[apiKey];
            card.remove(); // Remove from DOM
            showMessage('端点 /' + apiKey + ' 已删除。点击"保存所有配置"以确认。', 'success');
            // Update batch selection state if needed
            handleCheckboxChange();
        }

        function renderApiEndpoint(apiKey, configEntry) {
            const card = document.createElement('div');
            card.className = 'card';
            card.setAttribute('data-api-key', apiKey);

            const cardHeader = document.createElement('div');
            cardHeader.className = 'card-header d-flex justify-content-between align-items-center';
            cardHeader.innerHTML = 
                '<div class="d-flex align-items-center">' +
                     '<input class="form-check-input me-2 endpoint-checkbox" type="checkbox" value="' + apiKey + '" onchange="handleCheckboxChange()">' +
                     '<span>端点: /<input type="text" value="' + apiKey + '" class="api-key-input" aria-label="API 端点路径" placeholder="路径名" required></span>' +
                '</div>' +
                '<button type="button" class="btn btn-danger btn-sm delete-endpoint-button" aria-label="删除此端点" onclick="removeApiEndpoint(this.closest(\\\'.card\\\'))">' +
                    '<i class="bi bi-trash"></i> 删除' +
                '</button>';
            card.appendChild(cardHeader);

            const cardBody = document.createElement('div');
            cardBody.className = 'card-body';

            // Group Input
            cardBody.innerHTML += 
                '<div class="row mb-3 align-items-center">' +
                    '<label for="' + apiKey + '-group" class="col-sm-3 col-form-label text-sm-end" title="用于分类显示的组名">分组:</label>' +
                    '<div class="col-sm-9">' +
                        '<input type="text" class="form-control" id="' + apiKey + '-group" name="' + apiKey + '-group" value="' + (configEntry.group || '') + '" placeholder="例如: AI绘图, 表情包">' +
                    '</div>' +
                '</div>';

             // Type Dropdown
            const typeImageSelected = (!configEntry.type || configEntry.type === 'image') ? 'selected' : '';
            const typeVideoSelected = configEntry.type === 'video' ? 'selected' : '';
            
            cardBody.innerHTML += 
                '<div class="row mb-3 align-items-center">' +
                    '<label for="' + apiKey + '-type" class="col-sm-3 col-form-label text-sm-end" title="API 返回的内容类型">类型:</label>' +
                    '<div class="col-sm-9">' +
                        '<select class="form-select" id="' + apiKey + '-type" name="' + apiKey + '-type">' +
                            '<option value="image" ' + typeImageSelected + '>图片 (Image)</option>' +
                            '<option value="video" ' + typeVideoSelected + '>视频 (Video)</option>' +
                        '</select>' +
                    '</div>' +
                '</div>';

            // Description
            cardBody.innerHTML += 
                '<div class="row mb-3 align-items-center">' +
                    '<label for="' + apiKey + '-description" class="col-sm-3 col-form-label text-sm-end" title="这个 API 端点的用途说明">描述:</label>' +
                    '<div class="col-sm-9">' +
                        '<textarea class="form-control" id="' + apiKey + '-description" name="' + apiKey + '-description" placeholder="例如：获取随机猫咪图片">' + (configEntry.description || '') + '</textarea>' +
                    '</div>' +
                '</div>';

            // URL
            const urlWarning = (configEntry.urlConstruction && configEntry.urlConstruction.startsWith('special_')) ? 
                '<i class="bi bi-exclamation-triangle-fill text-warning tooltip-icon" data-bs-toggle="tooltip" data-bs-placement="top" title="注意: 此端点原配置包含特殊 URL 构建逻辑 (' + configEntry.urlConstruction + '), 修改基础 URL 可能影响其功能。"></i>' : '';
            
            cardBody.innerHTML += 
                '<div class="row mb-3 align-items-center">' +
                    '<label for="' + apiKey + '-url" class="col-sm-3 col-form-label text-sm-end" title="目标 API 的基础地址">目标 URL:</label>' +
                    '<div class="col-sm-8">' +
                        '<input type="url" class="form-control" id="' + apiKey + '-url" name="' + apiKey + '-url" value="' + (configEntry.url || '') + '" placeholder="https://api.example.com/data" required>' +
                    '</div>' +
                     '<div class="col-sm-1">' + urlWarning + '</div>' +
                '</div>';

            // Method Dropdown
            const methodRedirectSelected = configEntry.method === 'redirect' ? 'selected' : '';
            const methodProxySelected = configEntry.method === 'proxy' ? 'selected' : '';

            cardBody.innerHTML += 
                '<div class="row mb-3 align-items-center">' +
                    '<label for="' + apiKey + '-method" class="col-sm-3 col-form-label text-sm-end" title="服务器处理此请求的方式">处理方式:</label>' +
                    '<div class="col-sm-8">' +
                        '<select class="form-select" id="' + apiKey + '-method" name="' + apiKey + '-method">' +
                            '<option value="redirect" ' + methodRedirectSelected + '>浏览器重定向 (302)</option>' +
                            '<option value="proxy" ' + methodProxySelected + '>服务器代理请求</option>' +
                        '</select>' +
                    '</div>' +
                     '<div class="col-sm-1">' +
                         '<i class="bi bi-info-circle tooltip-icon" data-bs-toggle="tooltip" data-bs-placement="top" title="\\\'重定向\\\': 服务器告诉浏览器去访问目标 URL。\\\'代理\\\': 服务器代替浏览器去访问目标 URL，然后将结果返回给浏览器。"></i>' +
                     '</div>' +
                '</div>';

            // Proxy Settings Container
            const proxySettingsDiv = document.createElement('div');
            proxySettingsDiv.className = 'proxy-settings mt-3 pt-3 border-top';
            proxySettingsDiv.style.display = configEntry.method === 'proxy' ? 'block' : 'none';
            proxySettingsDiv.innerHTML = '<h5>代理设置</h5>';

            // Image URL Field
            proxySettingsDiv.innerHTML += \`
                <div class="row mb-3 align-items-center">
                    <label for="\${apiKey}-imageUrlField" class="col-sm-3 col-form-label text-sm-end" title="如果目标 API 返回 JSON，指定包含图片链接的字段路径">图片链接字段:</label>
                    <div class="col-sm-8">
                        <input type="text" class="form-control" id="\${apiKey}-imageUrlField" name="\${apiKey}-imageUrlField" value="\${configEntry.proxySettings?.imageUrlField || ''}" placeholder="例如: data.url 或 image" \${apiKey === 'forward' ? 'readonly' : ''}>
                    </div>
                     <div class="col-sm-1">
                         <i class="bi bi-info-circle tooltip-icon" data-bs-toggle="tooltip" data-bs-placement="top" title="\${apiKey === 'forward' ? "对于 /forward 路由，此设置由 'field' 查询参数动态决定（默认为 'url'）。" : '用于从 JSON 响应中提取图片链接。支持用点(.)访问嵌套字段，如 "result.data.imageUrl"。如果为空，则不尝试提取。'}"></i>
                     </div>
                </div>\`;
             if (apiKey === 'forward') {
                 const input = proxySettingsDiv.querySelector(\`#\${apiKey}-imageUrlField\`);
                 if(input) input.value = "(由 'field' 参数决定)";
             }


            // Fallback Action Dropdown
            proxySettingsDiv.innerHTML += \`
                <div class="row mb-3 align-items-center">
                    <label for="\${apiKey}-fallbackAction" class="col-sm-3 col-form-label text-sm-end" title="当无法提取到图片链接时的处理方式">提取图片失败时:</label>
                    <div class="col-sm-8">
                        <select class="form-select" id="\${apiKey}-fallbackAction" name="\${apiKey}-fallbackAction">
                            <option value="returnJson" \${(configEntry.proxySettings?.fallbackAction === 'returnJson' || !configEntry.proxySettings?.fallbackAction) ? 'selected' : ''}>返回原始 JSON</option>
                            <option value="error" \${configEntry.proxySettings?.fallbackAction === 'error' ? 'selected' : ''}>返回错误信息</option>
                        </select>
                    </div>
                     <div class="col-sm-1">
                          <i class="bi bi-info-circle tooltip-icon" data-bs-toggle="tooltip" data-bs-placement="top" title='如果设置了“图片链接字段”但无法找到有效的图片链接，服务器应如何响应。'></i>
                     </div>
                </div>\`;
            cardBody.appendChild(proxySettingsDiv);

            // Query Parameters Container
            const queryParamsDiv = document.createElement('div');
            queryParamsDiv.className = 'query-params mt-3 pt-3 border-top';
            queryParamsDiv.innerHTML = '<h5>查询参数配置</h5>';
            const paramsListDiv = document.createElement('div');
            paramsListDiv.id = \`\${apiKey}-params-list\`;

            (configEntry.queryParams || []).forEach((param, index) => {
                renderQueryParam(paramsListDiv, apiKey, param, index);
            });

            queryParamsDiv.appendChild(paramsListDiv);

            const addParamButton = document.createElement('button');
            addParamButton.type = 'button';
            addParamButton.innerHTML = '<i class="bi bi-plus-circle"></i> 添加查询参数';
            addParamButton.className = 'btn btn-outline-secondary btn-sm add-param-button mt-2';
            addParamButton.onclick = () => addQueryParam(paramsListDiv, apiKey);
            queryParamsDiv.appendChild(addParamButton);

            cardBody.appendChild(queryParamsDiv);
            card.appendChild(cardBody);


            // Event listener to toggle proxy settings visibility
            const methodSelect = cardBody.querySelector(\`#\${apiKey}-method\`);
            methodSelect.addEventListener('change', (event) => {
                proxySettingsDiv.style.display = event.target.value === 'proxy' ? 'block' : 'none';
            });

            return card;
        }

        function renderConfig() {
            disposeAllTooltips(); // Dispose existing tooltips before clearing
            apiConfigsContainer.innerHTML = '';
            // --- Get references to batch elements ---
            const batchActionsSection = document.getElementById('batch-actions-section');
            const selectAllCheckbox = document.getElementById('select-all-checkbox');
            const batchMoveGroupSelect = document.getElementById('batch-move-group-select');
            // --- Ensure elements exist before proceeding ---
            if (!batchActionsSection || !selectAllCheckbox || !batchMoveGroupSelect) {
                 console.error("Batch action elements not found in the DOM!");
                 return; // Stop rendering if essential elements are missing
            }

            // Clear previous group options in batch move dropdown
            batchMoveGroupSelect.innerHTML = '<option value="" selected disabled>选择目标分组...</option>';
            // Add "默认分组" option explicitly
            batchMoveGroupSelect.add(new Option('默认分组', '默认分组'));

            const apiUrls = currentConfigData.apiUrls || {};
            const groupedEndpoints = {};
            const allGroupNames = new Set(['默认分组']); // Start with '默认分组'

            for (const apiKey in apiUrls) {
                const entry = apiUrls[apiKey];
                const group = entry.group || '默认分组';
                allGroupNames.add(group); // Collect all unique group names
                if (!groupedEndpoints[group]) { groupedEndpoints[group] = []; }
                groupedEndpoints[group].push({ key: apiKey, config: entry });
            }

            // Populate batch move dropdown with sorted unique group names
            const sortedAllGroupNames = Array.from(allGroupNames).sort((a, b) => {
                 const order = {'通用转发': 1, 'AI绘图': 2, '二次元图片': 3, '三次元图片': 4, '表情包': 5, '696898': 6, '默认分组': 99}; // Added 696898
                 return (order[a] || 99) - (order[b] || 99);
            });
            sortedAllGroupNames.forEach(groupName => {
                 if (groupName !== '默认分组') { // Avoid adding '默认分组' twice
                     batchMoveGroupSelect.add(new Option(groupName, groupName));
                 }
            });


            const sortedGroups = Object.keys(groupedEndpoints).sort((a, b) => {
                 const order = {'通用转发': 1, 'AI绘图': 2, '二次元图片': 3, '三次元图片': 4, '表情包': 5, '696898': 6, '默认分组': 99}; // Added 696898
                 return (order[a] || 99) - (order[b] || 99);
            });
            
            console.log('[Debug] Batch Actions Section Element:', batchActionsSection); // Debug Log 1
            const numApiUrls = Object.keys(apiUrls).length;
            console.log('[Debug] Number of API URLs:', numApiUrls); // Debug Log 2

            // --- Always show batch section, buttons might be disabled if empty ---
            console.log('[Debug] Ensuring batch actions section is visible.'); // Debug Log 3b
            batchActionsSection.style.display = 'block'; // Always show batch actions

            // --- Render groups and endpoints ---
            if (numApiUrls === 0) {
                 apiConfigsContainer.innerHTML = '<div class="alert alert-info">当前没有配置任何 API 端点。点击“添加新 API 端点”开始。</div>';
            } else {
                 // Clear container before rendering groups
                 apiConfigsContainer.innerHTML = '';
                 sortedGroups.forEach(groupName => {
                    const groupContainer = document.createElement('div'); // Container for the group
                    groupContainer.id = \`group-\${groupName.replace(/\\s+/g, '-')}\`; // Create an ID for the group container

                    const groupTitle = document.createElement('h2');
                    groupTitle.className = 'group-title d-flex align-items-center'; // Use flex for alignment
                    groupTitle.innerHTML = \`
                         <input type="checkbox" class="form-check-input me-2 group-select-all-checkbox" onchange="toggleSelectGroup(this, '\${groupName}')" aria-label="全选/取消全选 \${groupName} 分组">
                         \${groupName}
                    \`;
                    groupContainer.appendChild(groupTitle); // Add title with checkbox to group container

                    // Removed logic to inject global settings into AI group

                    // Sort and render endpoints within the group
                     groupedEndpoints[groupName].sort((a, b) => a.key.localeCompare(b.key));
                    groupedEndpoints[groupName].forEach(item => {
                        const cardElement = renderApiEndpoint(item.key, item.config);
                        groupContainer.appendChild(cardElement); // Add card to group container
                    });

                    apiConfigsContainer.appendChild(groupContainer); // Add the whole group container
                });
            }

            // baseTag input removed - no longer needed


            setTimeout(() => initializeTooltips(document.body), 100);
        }

        function renderQueryParam(container, apiKey, param, index) {
             const paramDiv = document.createElement('div');
             paramDiv.className = 'param-item p-3 mb-3';
             const uniquePrefix = \`\${apiKey}-param-\${index}\`;

             paramDiv.innerHTML = \`
                <button type="button" class="btn btn-danger btn-sm remove-param-button" title="移除此参数" onclick="removeQueryParam(this)"><i class="bi bi-x-lg"></i></button>
                <div class="row mb-2 align-items-center">
                    <label for="\${uniquePrefix}-name" class="col-sm-3 col-form-label text-sm-end" title="URL 中的参数名">参数名称:</label>
                    <div class="col-sm-9">
                        <input type="text" class="form-control form-control-sm" id="\${uniquePrefix}-name" name="\${uniquePrefix}-name" value="\${param.name || ''}" required placeholder="例如: keyword">
                    </div>
                </div>
                <div class="row mb-2 align-items-center">
                    <label for="\${uniquePrefix}-desc" class="col-sm-3 col-form-label text-sm-end" title="参数用途说明">参数描述:</label>
                    <div class="col-sm-9">
                        <textarea class="form-control form-control-sm" id="\${uniquePrefix}-desc" name="\${uniquePrefix}-desc" placeholder="例如: 搜索关键词">\${param.description || ''}</textarea>
                    </div>
                </div>
                 <div class="row mb-2 align-items-center">
                    <label for="\${uniquePrefix}-required" class="col-sm-3 form-check-label text-sm-end" title="请求时必须提供此参数">是否必需:</label>
                     <div class="col-sm-9">
                        <div class="form-check form-switch">
                             <input class="form-check-input" type="checkbox" role="switch" id="\${uniquePrefix}-required" name="\${uniquePrefix}-required" \${param.required ? 'checked' : ''}>
                        </div>
                    </div>
                </div>
                 <div class="row mb-2 align-items-center">
                    <label for="\${uniquePrefix}-default" class="col-sm-3 col-form-label text-sm-end" title="未提供参数时的默认值">默认值:</label>
                    <div class="col-sm-9">
                        <input type="text" class="form-control form-control-sm" id="\${uniquePrefix}-default" name="\${uniquePrefix}-default" value="\${param.defaultValue || ''}" placeholder="可选">
                    </div>
                </div>
                 <div class="row mb-2 align-items-center">
                    <label for="\${uniquePrefix}-validValues" class="col-sm-3 col-form-label text-sm-end" title="限制参数的有效值（逗号分隔）">有效值:</label>
                    <div class="col-sm-8">
                        <input type="text" class="form-control form-control-sm" id="\${uniquePrefix}-validValues" name="\${uniquePrefix}-validValues" value="\${(param.validValues || []).join(',')}" placeholder="可选, 例如: value1,value2">
                    </div>
                     <div class="col-sm-1">
                         <i class="bi bi-info-circle tooltip-icon" data-bs-toggle="tooltip" data-bs-placement="top" title='如果填写，参数值必须是列表中的一个（用逗号分隔）。留空则不限制。'></i>
                     </div>
                </div>
             \`;
             container.appendChild(paramDiv);
             setTimeout(() => initializeTooltips(paramDiv), 50);
        }

        function addQueryParam(container, apiKey) {
            const existingParams = container.querySelectorAll('.param-item');
            const newIndex = existingParams.length;
            const newParam = { name: '', description: '', required: false, defaultValue: '', validValues: [] };
            renderQueryParam(container, apiKey, newParam, newIndex);
        }

        function removeQueryParam(button) {
            const paramItem = button.closest('.param-item');
            if (paramItem) { paramItem.remove(); }
        }

        function addApiEndpoint() {
             const newApiKey = \`new_endpoint_\${Date.now()}\`;
             const newConfigEntry = { group: "默认分组", description: "", url: "", method: "redirect", queryParams: [], proxySettings: {} };
             if (!apiConfigsContainer.querySelector('.card')) {
                 apiConfigsContainer.innerHTML = '';
             }
             // Find or create the '默认分组' section
             let ungroupedContainer = apiConfigsContainer.querySelector('#group-默认分组');
             if (!ungroupedContainer) {
                 const groupTitle = document.createElement('h2');
                 groupTitle.className = 'group-title';
                 groupTitle.textContent = '默认分组';
                 apiConfigsContainer.appendChild(groupTitle);
                 ungroupedContainer = document.createElement('div');
                 ungroupedContainer.id = 'group-默认分组'; // Assign ID to the container
                 apiConfigsContainer.appendChild(ungroupedContainer);
             }
             const cardElement = renderApiEndpoint(newApiKey, newConfigEntry);
             ungroupedContainer.appendChild(cardElement);

             // 不再自动滚动到新卡片，方便批量添加
             // 只聚焦输入框，用户可以手动滚动查看
             cardElement.querySelector('.api-key-input').focus({ preventScroll: true });
        }

        // Old removeApiEndpoint removed


        // --- Batch Action Functions ---



        function getSelectedApiKeys() {
            const cardKeys = Array.from(document.querySelectorAll('.endpoint-checkbox:checked')).map(cb => cb.value);
            const tableKeys = Array.from(document.querySelectorAll('.table-row-checkbox:checked')).map(cb => cb.value);
            // Use Set to unique keys if they overlap (though physically they are different elements)
            return [...new Set([...cardKeys, ...tableKeys])];
        }

        function updateBatchActionButtonsState() {
            const selectedKeys = getSelectedApiKeys();
            const count = selectedKeys.length;
            const batchDeleteButton = document.getElementById('batch-delete-button');
            const batchMoveButton = document.getElementById('batch-move-button');
            const batchMoveGroupSelect = document.getElementById('batch-move-group-select');
            const selectedCountSpan = document.getElementById('selected-count');
            const selectAllCheckbox = document.getElementById('select-all-checkbox');
            const allCheckboxes = apiConfigsContainer.querySelectorAll('.endpoint-checkbox');

            selectedCountSpan.textContent = count;
            batchDeleteButton.disabled = count === 0;
            batchMoveButton.disabled = count === 0 || !batchMoveGroupSelect.value;
            batchMoveGroupSelect.disabled = count === 0;

            // Update main select-all checkbox state
            if (allCheckboxes.length > 0 && count === allCheckboxes.length) {
                 selectAllCheckbox.checked = true;
                 selectAllCheckbox.indeterminate = false;
            } else if (count > 0) {
                 selectAllCheckbox.checked = false;
                 selectAllCheckbox.indeterminate = true;
            } else {
                 selectAllCheckbox.checked = false;
                 selectAllCheckbox.indeterminate = false;
            }

            // Update group select-all checkboxes
            document.querySelectorAll('.group-select-all-checkbox').forEach(groupCb => {
                 const groupContainer = groupCb.closest('div[id^="group-"]');
                 if (!groupContainer) return;
                 const groupCheckboxes = groupContainer.querySelectorAll('.endpoint-checkbox');
                 const groupSelectedCount = groupContainer.querySelectorAll('.endpoint-checkbox:checked').length;

                 if (groupCheckboxes.length > 0 && groupSelectedCount === groupCheckboxes.length) {
                     groupCb.checked = true;
                     groupCb.indeterminate = false;
                 } else if (groupSelectedCount > 0) {
                     groupCb.checked = false;
                     groupCb.indeterminate = true;
                 } else {
                     groupCb.checked = false;
                     groupCb.indeterminate = false;
                 }
            });
        }

        function handleCheckboxChange() {
            updateBatchActionButtonsState();
        }

        function toggleSelectAll(checked) {
            apiConfigsContainer.querySelectorAll('.endpoint-checkbox').forEach(cb => {
                cb.checked = checked;
            });
            handleCheckboxChange();
        }

        function toggleSelectGroup(groupCheckbox, groupName) {
             const groupContainer = document.getElementById(\`group-\${groupName.replace(/\\s+/g, '-')}\`);
             if (groupContainer) {
                 groupContainer.querySelectorAll('.endpoint-checkbox').forEach(cb => {
                     cb.checked = groupCheckbox.checked;
                 });
             }
             handleCheckboxChange();
        }

        function batchDeleteEndpoints() {
            try {
                const selectedKeys = getSelectedApiKeys();
                if (selectedKeys.length === 0) {
                    showMessage('请先选择要删除的端点。', 'error');
                    return;
                }
                
                // No confirmation
                let deletedCount = 0;
                const container = document.getElementById('api-configs-container');
                
                selectedKeys.forEach(apiKey => {
                    // Delete from data
                    delete currentConfigData.apiUrls[apiKey];
                    
                    // Remove from Card View
                    const card = container ? container.querySelector('.card[data-api-key="' + apiKey + '"]') : null;
                    if (card) {
                        const parentGroupContainer = card.parentElement;
                        card.remove();
                        // Check if group is now empty
                        if (parentGroupContainer && !parentGroupContainer.querySelector('.card')) {
                            const groupTitle = parentGroupContainer.previousElementSibling;
                            if (groupTitle && groupTitle.classList.contains('group-title')) {
                                groupTitle.remove();
                            }
                            parentGroupContainer.remove();
                        }
                    }
                    
                    // Remove from Table View
                    const tableRow = document.querySelector('tr[data-api-key="' + apiKey + '"]');
                    if (tableRow) {
                        tableRow.remove();
                    }
                    
                    deletedCount++;
                });
                
                try {
                    handleCheckboxChange(); // Update counts and button states
                } catch (e) { console.warn("Error updating batch buttons:", e); }

                showMessage('已标记删除 ' + deletedCount + ' 个端点。点击“保存所有配置”以确认。', 'success');
                
            } catch (error) {
                console.error("Error in batchDeleteEndpoints:", error);
                showMessage("批量删除操作出错: " + error.message, "error");
            }
        }

        function batchMoveGroup() {
            const selectedKeys = getSelectedApiKeys();
            const targetGroup = document.getElementById('batch-move-group-select').value;

            if (selectedKeys.length === 0) {
                showMessage('请先选择要移动的端点。', 'error');
                return;
            }
            if (!targetGroup) {
                showMessage('请选择目标分组。', 'error');
                return;
            }

            let movedCount = 0;
            selectedKeys.forEach(apiKey => {
                const card = apiConfigsContainer.querySelector(\`.card[data-api-key="\${apiKey}"]\`);
                if (card) {
                    const groupInput = card.querySelector(\`input[id="\${apiKey}-group"]\`);
                    if (groupInput) {
                        groupInput.value = targetGroup;
                        movedCount++;
                    }
                }
            });

            // Re-render the entire config to reflect the group changes visually
            // This is simpler than manually moving cards between group containers
            showMessage(\`已将 \${movedCount} 个端点的分组更改为 "\${targetGroup}"。点击“保存所有配置”以确认。\`, 'success');
            // Temporarily store current form data before re-rendering
            const currentFormData = collectFormData();
            currentConfigData.apiUrls = currentFormData.apiUrls; // Update in-memory data
            // baseTag removed
            renderConfig(); // Re-render based on updated in-memory data
            // Restore checkbox states after re-render (optional, but good UX)
            selectedKeys.forEach(apiKey => {
                 const newCheckbox = apiConfigsContainer.querySelector(\`.endpoint-checkbox[value="\${apiKey}"]\`);
                 if (newCheckbox) newCheckbox.checked = true;
            });
            handleCheckboxChange(); // Update batch counts again after re-render
        }

        function addNewGroup() {
            const newGroupName = prompt("请输入新分组的名称:", "");
            if (!newGroupName || !newGroupName.trim()) {
                showMessage("分组名称不能为空。", "error");
                return;
            }
            const trimmedGroupName = newGroupName.trim();
            const groupId = \`group-\${trimmedGroupName.replace(/\\s+/g, '-')}\`;

            // 检查分组是否已存在 (UI层面)
            if (document.getElementById(groupId)) {
                showMessage(\`分组 "\${trimmedGroupName}" 已经存在。\`, "error");
                return;
            }

            // 创建分组标题和容器
            const groupContainer = document.createElement('div');
            groupContainer.id = groupId;

            const groupTitle = document.createElement('h2');
            groupTitle.className = 'group-title d-flex align-items-center';
            groupTitle.innerHTML = \`
                 <input type="checkbox" class="form-check-input me-2 group-select-all-checkbox" onchange="toggleSelectGroup(this, '\${trimmedGroupName}')" aria-label="全选/取消全选 \${trimmedGroupName} 分组">
                 \${trimmedGroupName}
            \`;
            groupContainer.appendChild(groupTitle);

            // 将新分组添加到容器末尾 (或者可以根据排序规则插入)
            apiConfigsContainer.appendChild(groupContainer);

            // 更新批量移动下拉列表
            const batchMoveGroupSelect = document.getElementById('batch-move-group-select');
            // 检查是否已存在该选项
            let exists = false;
            for (let i = 0; i < batchMoveGroupSelect.options.length; i++) {
                if (batchMoveGroupSelect.options[i].value === trimmedGroupName) {
                    exists = true;
                    break;
                }
            }
            if (!exists) {
                 batchMoveGroupSelect.add(new Option(trimmedGroupName, trimmedGroupName));
                 // 可选：对下拉列表重新排序
                 sortSelectOptions(batchMoveGroupSelect);
            }


            showMessage(\`新分组 "\${trimmedGroupName}" 已添加。您可以在此分组下添加端点，或将现有端点移动到此分组。记得保存配置。\`, 'success');
            groupTitle.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        // Helper function to sort select options (used after adding a new group)
        function sortSelectOptions(selectElement) {
            const options = Array.from(selectElement.options);
            // 保留第一个 "选择目标分组..." 选项
            const firstOption = options.shift();
            const order = {'通用转发': 1, 'AI绘图': 2, '二次元图片': 3, '三次元图片': 4, '表情包': 5, '696898': 6, '默认分组': 99};
            options.sort((a, b) => {
                 const orderA = order[a.value] || 99;
                 const orderB = order[b.value] || 99;
                 return orderA - orderB || a.text.localeCompare(b.text);
            });
            selectElement.innerHTML = ''; // 清空
            selectElement.appendChild(firstOption); // 重新添加第一个选项
            options.forEach(option => selectElement.appendChild(option));
        }


        // Helper function to collect current form data before re-rendering after move
        function collectFormData() {
             const updatedApiUrls = {};
             const cards = apiConfigsContainer.querySelectorAll('.card[data-api-key]');
             cards.forEach(card => {
                 const apiKeyInput = card.querySelector('.api-key-input');
                 const apiKey = sanitizeApiKey(apiKeyInput.value.trim());
                 const originalApiKey = card.getAttribute('data-api-key');
                 if (!apiKey) return; // Skip invalid ones for this temporary collection

                 const configEntry = {
                     group: card.querySelector(\`[id="\${originalApiKey}-group"]\`).value.trim() || '默认分组',
                     description: card.querySelector(\`[id="\${originalApiKey}-description"]\`).value.trim(),
                     url: card.querySelector(\`[id="\${originalApiKey}-url"]\`).value.trim(),
                     method: card.querySelector(\`[id="\${originalApiKey}-method"]\`).value,
                     queryParams: [],
                     proxySettings: {}
                 };
                 // Simplified collection - just get the basics needed for re-render
                 updatedApiUrls[apiKey] = configEntry;
             });
             // Get baseTag value removed
             return {
                 apiUrls: updatedApiUrls
             };
        }


        async function loadConfig() {
            apiConfigsContainer.innerHTML = '<div class="text-center"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">正在加载配置...</span></div><p class="mt-2">正在加载配置...</p></div>'; // Changed to string concatenation
            // The line that hid the batch section initially has been removed.
            try {
                const response = await fetch('/config', { credentials: 'same-origin' });
                if (!response.ok) throw new Error(\`HTTP error! status: \${response.status}\`);
                currentConfigData = await response.json();
                if (!currentConfigData.apiUrls) currentConfigData.apiUrls = {};
                renderConfig();
                handleCheckboxChange(); // Initial update for batch buttons
            } catch (error) {
                console.error('Error loading config:', error);
                apiConfigsContainer.innerHTML = '<div class="alert alert-danger">加载配置失败。</div>';
                showMessage('加载配置失败: ' + error.message, 'error');
            }
        }

        async function saveConfig(event) {
            event.preventDefault();

            let updatedApiUrls = {};
            let hasError = false;
            
            // 如果当前是表格视图，直接使用 currentConfigData
            if (currentView === 'table') {
                // 验证表格数据
                for (const apiKey in currentConfigData.apiUrls) {
                    const entry = currentConfigData.apiUrls[apiKey];
                    if (!apiKey || apiKey.startsWith('new_')) {
                        showMessage('错误：发现未命名的 API 端点！请输入正确的路径名。', 'error');
                        hasError = true;
                        break;
                    }
                    if (!entry.url) {
                        showMessage('错误：端点 /' + apiKey + ' 的目标 URL 不能为空！', 'error');
                        hasError = true;
                        break;
                    }
                }
                if (!hasError) {
                    updatedApiUrls = currentConfigData.apiUrls;
                }

            } else {
                // 卡片视图：从DOM收集数据
                const cards = apiConfigsContainer.querySelectorAll('.card[data-api-key]');
                const usedApiKeys = new Set();

                cards.forEach(card => {

                 if (hasError) return;
                const apiKeyInput = card.querySelector('.api-key-input');
                const apiKey = sanitizeApiKey(apiKeyInput.value.trim());
                const originalApiKey = card.getAttribute('data-api-key');

                 if (!apiKey) { showMessage('错误：发现一个未命名（为空）的 API 端点！请输入路径名。', 'error'); apiKeyInput.focus(); hasError = true; return; }
                 if (usedApiKeys.has(apiKey)) { showMessage('错误：API 端点路径 "/' + apiKey + '" 重复！请确保每个端点路径唯一。', 'error'); apiKeyInput.focus(); hasError = true; return; }
                 usedApiKeys.add(apiKey);

                const urlInput = card.querySelector('[id="' + originalApiKey + '-url"]');
                const configEntry = {
                    group: card.querySelector('[id="' + originalApiKey + '-group"]').value.trim() || '默认分组',
                    description: card.querySelector('[id="' + originalApiKey + '-description"]').value.trim(),
                    url: urlInput.value.trim(),
                    type: card.querySelector('[id="' + originalApiKey + '-type"]').value,
                    method: card.querySelector('[id="' + originalApiKey + '-method"]').value,
                    queryParams: [],
                    proxySettings: {}
                };

                if (!configEntry.url) { showMessage('错误：端点 /' + apiKey + ' 的目标 URL 不能为空！', 'error'); urlInput.focus(); hasError = true; return; }

                // Collect Query Params... (same as before)
                const paramItems = card.querySelectorAll('[id="' + originalApiKey + '-params-list"] .param-item');
                const paramNames = new Set();
                paramItems.forEach((paramItem) => {
                     if (hasError) return;
                     const nameInput = paramItem.querySelector('input[id$="-name"]');
                     const paramName = nameInput.value.trim();
                     if (!paramName) return;
                     if (paramNames.has(paramName)) { showMessage('错误：端点 /' + apiKey + ' 存在重复的查询参数名称 "' + paramName + '"！', 'error'); nameInput.focus(); hasError = true; return; }
                     paramNames.add(paramName);
                     const descInput = paramItem.querySelector('textarea[id$="-desc"]');
                     const requiredInput = paramItem.querySelector('input[id$="-required"]');
                     const defaultInput = paramItem.querySelector('input[id$="-default"]');
                     const validValuesInput = paramItem.querySelector('input[id$="-validValues"]');
                     const validValuesString = validValuesInput.value.trim();
                     configEntry.queryParams.push({
                         name: paramName, description: descInput.value.trim(), required: requiredInput.checked,
                         defaultValue: defaultInput.value.trim() || undefined,
                         validValues: validValuesString ? validValuesString.split(',').map(s => s.trim()).filter(Boolean) : undefined
                     });
                });
                 if (hasError) return;


                // Collect Proxy Settings... (same as before)
                if (configEntry.method === 'proxy') {
                    const imageUrlFieldInput = card.querySelector('#' + originalApiKey + '-imageUrlField');
                    const fallbackActionSelect = card.querySelector('#' + originalApiKey + '-fallbackAction');
                    const originalConfigEntry = currentConfigData.apiUrls[originalApiKey];
                    if (apiKey === 'forward' && originalConfigEntry?.proxySettings?.imageUrlFieldFromParam) {
                         configEntry.proxySettings.imageUrlFieldFromParam = originalConfigEntry.proxySettings.imageUrlFieldFromParam;
                    } else if (imageUrlFieldInput) {
                         configEntry.proxySettings.imageUrlField = imageUrlFieldInput.value.trim() || undefined;
                    }
                    configEntry.proxySettings.fallbackAction = fallbackActionSelect?.value || 'returnJson';
                }

                 const originalConfig = currentConfigData.apiUrls[originalApiKey];
                 if (originalConfig?.urlConstruction) { configEntry.urlConstruction = originalConfig.urlConstruction; }
                 if (originalConfig?.modelName) { configEntry.modelName = originalConfig.modelName; }

                updatedApiUrls[apiKey] = configEntry;
            });
            } // 关闭 else 分支

            if (hasError) { console.error("Validation errors found. Aborting save."); return; }

            // Get baseTag value from its global location
            const updatedConfig = {
                apiUrls: updatedApiUrls,
                baseTag: ''
            };
            console.log("Saving config:", JSON.stringify(updatedConfig, null, 2));

            const saveButton = form.querySelector('.save-button');
            saveButton.disabled = true;
            saveButton.innerHTML = \`<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 保存中...\`;

            try {
                const response = await fetch('/config', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updatedConfig), credentials: 'same-origin',
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || \`HTTP error! status: \${response.status}\`);
                showMessage(result.message || '配置已成功更新！所有更改已动态生效。', 'success');
                await loadConfig();
            } catch (error) {
                console.error('Error saving config:', error);
                showMessage('保存配置失败: ' + error.message, 'error');
            } finally {
                 saveButton.disabled = false;
                 saveButton.innerHTML = \`<i class="bi bi-save"></i> 保存所有配置\`;
            }
        }

        form.addEventListener('submit', saveConfig);
        
        // --- New Function: Fetch and Add Emoticons ---
        async function fetchAndAddEmoticons(button) {
            const originalHtml = button.innerHTML;
            button.disabled = true;
            button.innerHTML = \`<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 拉取中...\`;
            
            try {
                showMessage('正在从 https://pic.696898.xyz/pic/list 拉取表情包列表...', 'info');
                const response = await fetch('https://pic.696898.xyz/pic/list');
                if (!response.ok) {
                    throw new Error(\`HTTP error! status: \${response.status}\`);
                }
                const emoticonList = await response.json();
                
                if (!Array.isArray(emoticonList)) {
                     throw new Error('返回的数据格式不是有效的 JSON 数组');
                }
                
                showMessage(\`成功拉取 \${emoticonList.length} 个表情包列表，正在添加到配置中...\`, 'info');
                
                let addedCount = 0;
                let pinyinFunction;

                // Check for pinyin function availability
                if (typeof pinyinPro !== 'undefined' && typeof pinyinPro.pinyin === 'function') {
                    pinyinFunction = pinyinPro.pinyin;
                    console.log("Using pinyin function from pinyinPro.pinyin");
                } else {
                    // Log detailed error information
                    console.error('Pinyin function (pinyinPro.pinyin) not found after delay.');
                    console.log('pinyinPro object:', pinyinPro); 
                    if (pinyinPro) {
                         console.log('typeof pinyinPro.pinyin:', typeof pinyinPro.pinyin);
                    }
                    throw new Error('pinyin-pro 库未能正确加载或初始化。请检查网络连接、浏览器控制台或稍后再试。');
                }
                
                // Ensure the "696898" group container exists
                const targetGroupName = "696898";
                const targetGroupId = \`group-\${targetGroupName}\`;
                let emoticonGroupContainer = apiConfigsContainer.querySelector(\`#\${targetGroupId}\`);
                if (!emoticonGroupContainer) {
                    const groupTitle = document.createElement('h2');
                    groupTitle.className = 'group-title';
                    groupTitle.textContent = targetGroupName;
                    // Find the correct place to insert (e.g., before '默认分组' or at the end)
                    const ungroupedContainer = apiConfigsContainer.querySelector('#group-默认分组');
                    if (ungroupedContainer) {
                        apiConfigsContainer.insertBefore(groupTitle, ungroupedContainer);
                        emoticonGroupContainer = document.createElement('div');
                        emoticonGroupContainer.id = targetGroupId;
                        apiConfigsContainer.insertBefore(emoticonGroupContainer, ungroupedContainer);
                    } else {
                         apiConfigsContainer.appendChild(groupTitle);
                         emoticonGroupContainer = document.createElement('div');
                         emoticonGroupContainer.id = targetGroupId;
                         apiConfigsContainer.appendChild(emoticonGroupContainer);
                    }
                }

                emoticonList.forEach(item => {
                    if (item.name && item.path) { // Basic validation
                        let pinyinKey;
                        try {
                            // 尝试生成拼音首字母，保留非中文部分
                            let pinyinInitialsRaw = pinyinFunction(item.name, { pattern: 'initial', toneType: 'none', nonZh: 'keep' }); 
                            pinyinKey = sanitizeApiKey(pinyinInitialsRaw.toLowerCase().replace(/\s+/g, ''));
                        } catch (e) {
                            console.warn(\`Pinyin generation failed for "\${item.name}": \${e.message}\`);
                            pinyinKey = null; // 标记生成失败
                        }

                        // 如果拼音生成结果为空或失败，尝试使用原始名称（清理后）
                        if (!pinyinKey) {
                            console.warn(\`无法为 "\${item.name}" 生成有效拼音 Key，尝试使用原名。\`);
                            // 将空格替换为下划线，然后清理
                            pinyinKey = sanitizeApiKey(item.name.toLowerCase().replace(/\s+/g, '_')); 
                        }

                        // 最后检查是否成功生成了 Key
                        if (!pinyinKey) {
                             console.warn(\`无法为 "\${item.name}" 生成任何有效 Key，跳过。\`);
                             return; // 如果两种方法都失败，则跳过
                        }
                        
                        // 检查 Key 是否仍然为空（例如，如果原名只包含无效字符）
                        if (!pinyinKey) {
                             console.warn(\`为 "\${item.name}" 生成的 Key 清理后为空，跳过。\`);
                             return;
                        }
                        
                        // --- 新增：检查当前配置中是否已存在该 Key ---
                        if (currentConfigData.apiUrls[pinyinKey]) {
                            console.log(\`端点 /\${pinyinKey} (\${item.name}) 已存在于当前配置中，跳过添加。\`);
                            return; // 在 forEach 回调中使用 return 来跳过当前项
                        }
                        // --- 检查结束 ---

                        const newConfigEntry = {
                            group: targetGroupName, // Use the target group name
                            description: \`\${item.name} 表情包\`,
                            url: \`https://696898.xyz/pci?type=\${item.name}\`, // Use original name in URL
                            method: "redirect",
                            queryParams: [],
                            proxySettings: {}
                        };
                        
                        // // 不再需要检查和移除 UI 元素，因为我们基于数据进行判断
                        // const existingCard = apiConfigsContainer.querySelector(\`.card[data-api-key="\${pinyinKey}"]\`);
                        // if (existingCard) {
                        //     console.log(\`端点 /\${pinyinKey} 已存在，将覆盖。\`);
                        //     existingCard.remove();
                        // }

                        const cardElement = renderApiEndpoint(pinyinKey, newConfigEntry);
                        emoticonGroupContainer.appendChild(cardElement); // Add card to the "表情包" group
                        addedCount++;
                    } else {
                         console.warn('跳过无效的表情包条目:', item);
                    }
                });
                
                // Re-initialize tooltips for new elements
                setTimeout(() => initializeTooltips(emoticonGroupContainer), 100); 
                
                showMessage(\`成功添加/更新了 \${addedCount} 个表情包 API 端点。请检查配置并点击“保存所有配置”以生效。\`, 'success');
                
            } catch (error) {
                console.error('拉取或处理表情包失败:', error);
                showMessage(\`拉取表情包失败: \${error.message}\`, 'error');
            } finally {
                button.disabled = false;
                button.innerHTML = originalHtml;
            }
        }
        
        async function loadConfig() {
            try {
                const response = await fetch('/config', {
                    credentials: 'same-origin' // Ensure cookies are sent
                });
                if (response.status === 401 || response.status === 403) {
                    window.location.href = '/admin-login';
                    return;
                }
                const config = await response.json();
                currentConfigData = config; // Update global config data
                renderConfig();
            } catch (error) {
                console.error('Error loading config:', error);
                showMessage('加载配置失败: ' + error.message + ' (请尝试重新登录)', 'error');
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            loadConfig(); // Load existing config first

            // Check for pinyin library and enable button if available
            const fetchButton = document.querySelector('.fetch-emoticons-button');
            if (fetchButton) {
                // Give the CDN script a moment to load, then check
                setTimeout(() => {
                    // Check specifically for the expected function
                    if (typeof pinyinPro !== 'undefined' && typeof pinyinPro.pinyin === 'function') {
                        fetchButton.disabled = false;
                        console.log('pinyin-pro library (pinyinPro.pinyin) loaded successfully. Enabling fetch button.');
                    } else {
                        console.error('pinyin-pro library failed to load or initialize correctly after delay. Fetch button remains disabled.');
                        console.log('pinyinPro object:', pinyinPro);
                         if (pinyinPro) {
                             console.log('typeof pinyinPro.pinyin:', typeof pinyinPro.pinyin);
                         }
                        showMessage('无法加载拼音库，拉取表情包功能不可用。请检查网络、浏览器控制台或刷新页面重试。', 'error');
                    }
                }, 1000); // 1000ms delay
            }
        });
    </script>
</body>
</html>
`;
    res.setHeader('Content-Type', 'text/html');
    res.send(adminHtmlContent);
});


// --- Server Start ---
// 确保在服务器启动前先加载配置
(async () => {
    try {
        console.log('Loading configuration before starting server...');
        await loadConfig();
        console.log('Configuration loaded successfully.');

        // 启动服务器
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`API Forwarder running on http://localhost:${PORT}`);
            console.log(`Admin interface available at http://localhost:${PORT}/admin`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
})();
