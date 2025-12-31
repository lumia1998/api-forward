const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');

// === Configuration ===
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'config.db');
const adminToken = process.env.ADMIN_TOKEN || 'admin';
const adminCookieName = 'api_forward_admin_token';
const enableFileOperations = process.env.ENABLE_FILE_OPERATIONS !== 'false';
const configPath = path.join(__dirname, 'config.json');
const PORT = process.env.PORT || 3000;

// === Database Setup ===
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let db;
try {
    db = new Database(dbPath);
    console.log(`SQLite database initialized at: ${dbPath}`);

    db.exec(`
        CREATE TABLE IF NOT EXISTS global_settings (id INTEGER PRIMARY KEY CHECK (id = 1), base_tag TEXT DEFAULT '', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS api_endpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, api_key TEXT NOT NULL UNIQUE, group_name TEXT DEFAULT '默认分组', description TEXT DEFAULT '', url TEXT NOT NULL, method TEXT DEFAULT 'redirect', url_construction TEXT, model_name TEXT, proxy_image_url_field TEXT, proxy_image_url_field_from_param INTEGER DEFAULT 0, proxy_fallback_action TEXT DEFAULT 'returnJson', type TEXT DEFAULT 'image', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS query_params (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', required INTEGER DEFAULT 0, default_value TEXT, valid_values TEXT, sort_order INTEGER DEFAULT 0, FOREIGN KEY (endpoint_id) REFERENCES api_endpoints(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS idx_endpoints_api_key ON api_endpoints(api_key);
        CREATE INDEX IF NOT EXISTS idx_endpoints_group ON api_endpoints(group_name);
        CREATE INDEX IF NOT EXISTS idx_params_endpoint ON query_params(endpoint_id);
    `);
    console.log('Database tables initialized.');
} catch (error) {
    console.error('Failed to initialize SQLite database:', error);
    process.exit(1);
}

// === Config Management ===
let currentConfig = { apiUrls: {}, baseTag: '' };

function loadConfig() {
    try {
        const endpointCount = db.prepare('SELECT COUNT(*) as count FROM api_endpoints').get();

        if (endpointCount.count > 0) {
            const globalSettings = db.prepare('SELECT base_tag FROM global_settings WHERE id = 1').get();
            currentConfig.baseTag = globalSettings?.base_tag || '';

            const endpoints = db.prepare('SELECT * FROM api_endpoints').all();
            const allParams = db.prepare('SELECT * FROM query_params ORDER BY endpoint_id, sort_order').all();

            currentConfig.apiUrls = {};
            for (const ep of endpoints) {
                const queryParams = allParams.filter(p => p.endpoint_id === ep.id).map(p => ({
                    name: p.name, description: p.description || '', required: p.required === 1,
                    defaultValue: p.default_value || undefined,
                    validValues: p.valid_values ? JSON.parse(p.valid_values) : undefined
                }));

                currentConfig.apiUrls[ep.api_key] = {
                    group: ep.group_name || '默认分组',
                    description: ep.description || '',
                    url: ep.url || '',
                    method: ep.method || 'redirect',
                    type: ep.type || 'image',
                    queryParams,
                    proxySettings: {
                        imageUrlField: ep.proxy_image_url_field || undefined,
                        imageUrlFieldFromParam: ep.proxy_image_url_field_from_param === 1 || undefined,
                        fallbackAction: ep.proxy_fallback_action || 'returnJson'
                    }
                };
                if (ep.url_construction) currentConfig.apiUrls[ep.api_key].urlConstruction = ep.url_construction;
                if (ep.model_name) currentConfig.apiUrls[ep.api_key].modelName = ep.model_name;
            }
            console.log(`Configuration loaded: ${endpoints.length} endpoints.`);
        } else if (fs.existsSync(configPath)) {
            currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            console.log('Configuration loaded from local file.');
        } else {
            console.log('No configuration found. Using default.');
            currentConfig = { apiUrls: {}, baseTag: '' };
        }

        if (enableFileOperations) {
            try { fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), 'utf8'); } catch (e) { console.error('Backup write failed:', e); }
        }
    } catch (error) {
        console.error('Error loading configuration:', error);
        currentConfig = { apiUrls: {}, baseTag: '' };
    }
}

function saveConfig(newConfig) {
    currentConfig = newConfig;

    try {
        const saveTransaction = db.transaction(() => {
            db.prepare('INSERT OR REPLACE INTO global_settings (id, base_tag, updated_at) VALUES (1, ?, datetime("now"))').run(newConfig.baseTag || '');

            const existingKeys = db.prepare('SELECT api_key FROM api_endpoints').all().map(r => r.api_key);
            const newKeys = Object.keys(newConfig.apiUrls);

            existingKeys.filter(k => !newKeys.includes(k)).forEach(k => db.prepare('DELETE FROM api_endpoints WHERE api_key = ?').run(k));

            const upsert = db.prepare('INSERT INTO api_endpoints (api_key, group_name, description, url, method, url_construction, model_name, proxy_image_url_field, proxy_image_url_field_from_param, proxy_fallback_action, type, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now")) ON CONFLICT(api_key) DO UPDATE SET group_name=excluded.group_name, description=excluded.description, url=excluded.url, method=excluded.method, url_construction=excluded.url_construction, model_name=excluded.model_name, proxy_image_url_field=excluded.proxy_image_url_field, proxy_image_url_field_from_param=excluded.proxy_image_url_field_from_param, proxy_fallback_action=excluded.proxy_fallback_action, type=excluded.type, updated_at=datetime("now")');
            const deleteParams = db.prepare('DELETE FROM query_params WHERE endpoint_id = ?');
            const insertParam = db.prepare('INSERT INTO query_params (endpoint_id, name, description, required, default_value, valid_values, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
            const getEndpointId = db.prepare('SELECT id FROM api_endpoints WHERE api_key = ?');

            for (const [apiKey, config] of Object.entries(newConfig.apiUrls)) {
                upsert.run(apiKey, config.group || '默认分组', config.description || '', config.url || '', config.method || 'redirect', config.urlConstruction || null, config.modelName || null, config.proxySettings?.imageUrlField || null, config.proxySettings?.imageUrlFieldFromParam ? 1 : 0, config.proxySettings?.fallbackAction || 'returnJson', config.type || 'image');

                const row = getEndpointId.get(apiKey);
                if (row) {
                    deleteParams.run(row.id);
                    (config.queryParams || []).forEach((param, i) => insertParam.run(row.id, param.name || '', param.description || '', param.required ? 1 : 0, param.defaultValue || null, param.validValues ? JSON.stringify(param.validValues) : null, i));
                }
            }
        });
        saveTransaction();
        console.log('Configuration saved to database.');

        if (enableFileOperations) {
            try { fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), 'utf8'); } catch (e) { console.error('Backup write failed:', e); }
        }
        return { success: true, message: 'Configuration saved successfully.' };
    } catch (error) {
        console.error('Error saving configuration:', error);
        return { success: false, error: error.message };
    }
}

// === Utility Functions ===
function getValueByDotNotation(obj, path) {
    if (!path) return undefined;
    return path.split('.').reduce((curr, key) => curr?.[key], obj);
}

async function handleProxyRequest(targetUrl, proxySettings = {}, res) {
    try {
        console.log(`[Proxy] Requesting: ${targetUrl}`);
        const response = await axios.get(targetUrl, { timeout: 15000, validateStatus: s => s >= 200 && s < 500 });

        if (response.status >= 400) return res.status(response.status).json(response.data || { error: `Target API error (${response.status})` });

        let imageUrl = proxySettings.imageUrlField && response.data ? getValueByDotNotation(response.data, proxySettings.imageUrlField) : null;
        if (typeof imageUrl === 'string' && imageUrl.match(/\.(jpeg|jpg|gif|png|webp|bmp|svg)/i)) {
            console.log(`[Proxy] Redirecting to: ${imageUrl}`);
            return res.redirect(imageUrl);
        }

        const fallback = proxySettings.fallbackAction || 'returnJson';
        return fallback === 'error' ? res.status(404).json({ error: 'Could not extract image URL' }) : res.json(response.data);
    } catch (error) {
        console.error(`[Proxy] Failed: ${error.message}`);
        if (error.response) return res.status(error.response.status).json(error.response.data || { error: 'Proxy target error' });
        if (error.request) return res.status(504).json({ error: 'Proxy request timeout' });
        return res.status(500).json({ error: 'Proxy setup failed' });
    }
}

// === Express Setup ===
const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));

// === Auth Middleware ===
function checkAdminAuth(req, res, next) {
    if (req.cookies?.[adminCookieName] === adminToken) return next();
    if (req.path.startsWith('/config') || req.headers.accept?.includes('application/json')) return res.status(401).json({ error: 'Unauthorized' });
    res.redirect('/admin-login');
}

// === Routes ===
// Homepage data API
app.get('/api/homepage-data', (req, res) => {
    const baseURL = `${req.protocol}://${req.get('host')}`;
    const groupOrder = { 'AI绘图': 1, '二次元图片': 2, '三次元图片': 3, '表情包': 4, '默认分组': 99 };

    // Group endpoints
    const groupedApis = {};
    for (const key in currentConfig.apiUrls) {
        const entry = currentConfig.apiUrls[key];
        const group = entry.group || '默认分组';
        if (!groupedApis[group]) groupedApis[group] = [];
        groupedApis[group].push({ key, ...entry });
    }

    // Generate LLM prompt
    const allApis = Object.entries(currentConfig.apiUrls).map(([key, e]) => ({ key, ...e }));
    allApis.sort((a, b) => (groupOrder[a.group || '默认分组'] || 50) - (groupOrder[b.group || '默认分组'] || 50) || a.key.localeCompare(b.key));

    const pathFunctions = allApis.map(e => {
        const desc = e.description || e.group || '默认分组';
        return e.group === 'AI绘图' ? `${desc}:/${e.key}?tags=<tags>` : `${desc}:/${e.key}`;
    });

    const llmPrompt = `    picture_url: |
    {{ 
    根据用户请求，选择合适的图片API路径，生成并返回完整URL。仅输出最终URL。
    基础URL：${baseURL}
    可用路径：
${pathFunctions.map(p => `    - ${p}`).join('\n')}
    }}`;

    // Generate HTML for groups
    const sortedGroups = Object.keys(groupedApis).sort((a, b) => (groupOrder[a] || 99) - (groupOrder[b] || 99));
    let groupsHtml = '';

    sortedGroups.forEach(groupName => {
        groupedApis[groupName].sort((a, b) => a.key.localeCompare(b.key));
        let cardsHtml = '';
        groupedApis[groupName].forEach(entry => {
            const apiUrl = `${baseURL}/${entry.key}`;
            cardsHtml += `
            <div class="api-card">
                <div class="api-card-image" onclick="refreshImage(this, '${apiUrl}')">
                    <div class="media-loader"><div class="loader-spinner"></div><span>加载中...</span></div>
                    <img src="${apiUrl}?t=${Date.now()}" alt="${entry.description || entry.key}" loading="lazy" onload="hideLoader(this)" onerror="handleMediaError(this, '${apiUrl}')">
                    <div class="image-overlay"><span class="refresh-hint"><i class="bi bi-arrow-clockwise"></i> 点击刷新</span></div>
                    <span class="api-badge">${entry.description || entry.key}</span>
                </div>
                <div class="api-card-info">
                    <p class="api-hint">👆点击图片可刷新预览</p>
                    <p class="api-url">${apiUrl}</p>
                </div>
            </div>`;
        });
        groupsHtml += `<div class="group-section"><h3 class="group-title-home">${groupName}</h3><div class="cards-row">${cardsHtml}</div></div>`;
    });

    res.json({ llmPrompt, groupsHtml });
});

// Static HTML pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin-login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));
app.get('/admin', checkAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin-logout', (req, res) => { res.clearCookie(adminCookieName); res.redirect('/admin-login'); });

// Auth
app.post('/admin-auth', (req, res) => {
    if (req.body.token === adminToken) {
        res.cookie(adminCookieName, req.body.token, { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'strict' });
        res.json({ success: true });
    } else {
        res.status(401).json({ error: '无效的管理令牌' });
    }
});

// Config API
app.get('/config', checkAdminAuth, (req, res) => res.json(currentConfig));
app.post('/config', checkAdminAuth, (req, res) => {
    const newConfig = req.body;
    if (!newConfig?.apiUrls) return res.status(400).json({ error: 'Invalid configuration format.' });
    const result = saveConfig(newConfig);
    if (result.success) res.json({ message: result.message });
    else res.status(500).json({ error: result.error });
});

// === Dynamic API Routes ===
app.get('/:apiKey', async (req, res, next) => {
    const apiKey = req.params.apiKey;

    // Skip static files and system routes
    if (apiKey.includes('.') || apiKey === 'favicon.ico' || ['config', 'admin', 'admin-login', 'admin-logout', 'api'].includes(apiKey)) return next();

    const configEntry = currentConfig.apiUrls?.[apiKey];
    if (!configEntry?.method) return next();

    console.log(`[Router] Handling /${apiKey}`);

    // Special URL constructions
    if (configEntry.urlConstruction === 'special_forward') {
        const url = req.query.url;
        const field = req.query.field || configEntry.proxySettings?.imageUrlFieldFromParamDefault || 'url';
        if (!url) return res.status(400).json({ error: 'Missing url parameter' });
        return handleProxyRequest(url, { ...configEntry.proxySettings, imageUrlField: field }, res);
    }

    if (configEntry.urlConstruction === 'special_pollinations') {
        const tags = req.query.tags;
        if (!tags) return res.status(400).json({ error: 'Missing tags parameter' });
        const promptUrl = `${configEntry.url}${encodeURIComponent(tags)}%2c${currentConfig.baseTag || ''}?&model=${configEntry.modelName}&nologo=true`;
        return res.redirect(promptUrl);
    }

    if (configEntry.urlConstruction === 'special_draw_redirect') {
        const tags = req.query.tags;
        const model = req.query.model || configEntry.queryParams?.find(p => p.name === 'model')?.defaultValue || 'flux';
        if (!tags) return res.status(400).json({ error: 'Missing tags parameter' });
        return res.redirect(`/${model}?tags=${encodeURIComponent(tags)}`);
    }

    // Generic handler
    const validatedParams = {};
    const errors = [];

    for (const param of (configEntry.queryParams || [])) {
        const value = req.query[param.name];
        if (value !== undefined) {
            if (param.validValues && !param.validValues.includes(value)) {
                errors.push(`Invalid value for '${param.name}'`);
            } else {
                validatedParams[param.name] = value;
            }
        } else if (param.required) {
            errors.push(`Missing required parameter: ${param.name}`);
        } else if (param.defaultValue !== undefined) {
            validatedParams[param.name] = param.defaultValue;
        }
    }

    if (errors.length) return res.status(400).json({ error: 'Invalid parameters', details: errors });

    let targetUrl = configEntry.url;
    if (!targetUrl) return res.status(500).json({ error: 'Configuration URL missing' });

    if (Object.keys(validatedParams).length) {
        try {
            const url = new URL(targetUrl);
            Object.entries(validatedParams).forEach(([k, v]) => url.searchParams.append(k, v));
            targetUrl = url.toString();
        } catch {
            targetUrl += (targetUrl.includes('?') ? '&' : '?') + new URLSearchParams(validatedParams).toString();
        }
    }

    console.log(`[Router] Target: ${targetUrl}`);

    if (configEntry.method === 'proxy') return handleProxyRequest(targetUrl, configEntry.proxySettings, res);
    return res.redirect(targetUrl);
});

// === Server Start ===
(async () => {
    try {
        console.log('Loading configuration...');
        loadConfig();
        console.log('Configuration loaded.');

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`API Forwarder running on http://localhost:${PORT}`);
            console.log(`Admin interface at http://localhost:${PORT}/admin`);
        });
    } catch (error) {
        console.error('Failed to start:', error);
        process.exit(1);
    }
})();
