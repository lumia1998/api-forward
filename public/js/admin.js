// Admin Page JavaScript - Extracted from index.js
const form = document.getElementById('config-form');
const apiConfigsContainer = document.getElementById('api-configs-container');
const messageDiv = document.getElementById('message');
let currentConfigData = { apiUrls: {} };
let currentView = 'card';

// === Utility Functions ===
function showMessage(text, type = 'success') {
    messageDiv.textContent = text;
    messageDiv.className = `alert alert-${type === 'success' ? 'success' : 'danger'} mt-4`;
    messageDiv.style.display = 'block';
    setTimeout(() => messageDiv.style.display = 'none', 7000);
}

function sanitizeApiKey(key) {
    // 只过滤 URL 路径不安全的字符，保留：中文、英文、数字、连字符、下划线
    // 不安全字符包括：空格、/、?、#、&、=、%、@、:、;、+、!、*、'、(、)、,、[、]
    return key.replace(/[\s\/\?#&=%@:;+!*'(),\[\]<>{}|\\^`"]/g, '').trim();
}

// === View Switching ===
function switchView(view) {
    currentView = view;
    document.getElementById('table-view-btn').classList.toggle('active', view === 'table');
    document.getElementById('card-view-btn').classList.toggle('active', view === 'card');
    document.getElementById('table-view-container').classList.toggle('active', view === 'table');
    document.getElementById('card-view-container').classList.toggle('hidden', view === 'table');
    if (view === 'table') renderTableView();
    else renderConfig();
}

// === Table View ===
function renderTableView() {
    const tbody = document.getElementById('api-table-body');
    tbody.innerHTML = '';
    const apiUrls = currentConfigData.apiUrls || {};
    const groupedEndpoints = {};

    for (const apiKey in apiUrls) {
        const group = apiUrls[apiKey].group || '默认分组';
        if (!groupedEndpoints[group]) groupedEndpoints[group] = [];
        groupedEndpoints[group].push({ key: apiKey, config: apiUrls[apiKey] });
    }

    const sortedGroups = Object.keys(groupedEndpoints).sort((a, b) => {
        const order = { '通用转发': 1, 'AI绘图': 2, '二次元图片': 3, '三次元图片': 4, '表情包': 5, '默认分组': 99 };
        return (order[a] || 50) - (order[b] || 50);
    });

    sortedGroups.forEach(groupName => {
        groupedEndpoints[groupName].sort((a, b) => a.key.localeCompare(b.key));
        const groupRow = document.createElement('tr');
        groupRow.className = 'group-row';
        groupRow.innerHTML = `<td colspan="8" style="background:var(--v0-secondary);font-weight:600;padding:0.5rem 1rem;"><i class="bi bi-folder"></i> ${groupName} (${groupedEndpoints[groupName].length})</td>`;
        tbody.appendChild(groupRow);

        groupedEndpoints[groupName].forEach(item => tbody.appendChild(createTableRow(item.key, item.config)));
    });

    if (Object.keys(apiUrls).length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">暂无 API 端点</td></tr>';
    }
}

function createTableRow(apiKey, config) {
    const row = document.createElement('tr');
    row.setAttribute('data-api-key', apiKey);

    row.innerHTML = `
        <td><input type="checkbox" class="form-check-input table-row-checkbox" value="${apiKey}" onchange="updateTableSelectState()"></td>
        <td><span class="editable-cell" contenteditable="true" data-field="key" data-original="${apiKey}">${apiKey}</span></td>
        <td><span class="editable-cell" contenteditable="true" data-field="group">${config.group || '默认分组'}</span></td>
        <td><span class="editable-cell" contenteditable="true" data-field="description">${config.description || ''}</span></td>
        <td class="url-cell" title="${config.url || ''}"><span class="editable-cell" contenteditable="true" data-field="url">${config.url || ''}</span></td>
        <td><select class="form-select form-select-sm" data-field="type" onchange="markRowChanged(this)">
            <option value="image" ${config.type !== 'video' ? 'selected' : ''}>图片</option>
            <option value="video" ${config.type === 'video' ? 'selected' : ''}>视频</option>
        </select></td>
        <td><select class="form-select form-select-sm" data-field="method" onchange="markRowChanged(this)">
            <option value="redirect" ${config.method === 'redirect' ? 'selected' : ''}>重定向</option>
            <option value="proxy" ${config.method === 'proxy' ? 'selected' : ''}>代理</option>
        </select></td>
        <td class="text-center">
            <button type="button" class="btn btn-outline-primary btn-sm me-1" onclick="editInCardView('${apiKey}')" title="详细编辑"><i class="bi bi-pencil"></i></button>
            <button type="button" class="btn btn-outline-danger btn-sm" onclick="deleteTableRow(this)" title="删除"><i class="bi bi-trash"></i></button>
        </td>`;

    row.querySelectorAll('.editable-cell').forEach(cell => {
        cell.addEventListener('blur', () => syncTableCellToConfig(cell));
        cell.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); cell.blur(); } });
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
        if (sanitizedKey !== newValue) cell.textContent = sanitizedKey;
        if (sanitizedKey && sanitizedKey !== originalKey && currentConfigData.apiUrls[originalKey]) {
            currentConfigData.apiUrls[sanitizedKey] = currentConfigData.apiUrls[originalKey];
            delete currentConfigData.apiUrls[originalKey];
            row.setAttribute('data-api-key', sanitizedKey);
            row.querySelector('.table-row-checkbox').value = sanitizedKey;
        }
    } else if (currentConfigData.apiUrls[originalKey]) {
        currentConfigData.apiUrls[originalKey][field] = newValue;
    }
}

function markRowChanged(element) {
    const row = element.closest('tr');
    const apiKey = row.getAttribute('data-api-key');
    if (currentConfigData.apiUrls[apiKey]) {
        currentConfigData.apiUrls[apiKey][element.getAttribute('data-field')] = element.value;
    }
}

function addTableRow() {
    const newKey = 'new_' + Date.now();
    currentConfigData.apiUrls[newKey] = { group: '默认分组', description: '', url: '', type: 'image', method: 'redirect', queryParams: [], proxySettings: {} };
    const tbody = document.getElementById('api-table-body');
    const row = createTableRow(newKey, currentConfigData.apiUrls[newKey]);
    row.style.backgroundColor = '#fffce6';
    tbody.appendChild(row);
    const keyCell = row.querySelector('.editable-cell[data-field="key"]');
    if (keyCell) { keyCell.focus(); keyCell.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

function deleteTableRow(button) {
    const row = button.closest('tr');
    const apiKey = row.getAttribute('data-api-key');
    delete currentConfigData.apiUrls[apiKey];
    row.remove();
    showMessage(`端点 /${apiKey} 已删除。点击"保存"以确认。`, 'success');
    handleCheckboxChange();
}

function editInCardView(apiKey) {
    switchView('card');
    setTimeout(() => {
        const card = document.querySelector(`.card[data-api-key="${apiKey}"]`);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.style.boxShadow = '0 0 0 3px var(--v0-primary)';
            setTimeout(() => card.style.boxShadow = '', 2000);
        }
    }, 100);
}

function toggleTableSelectAll(checked) {
    document.querySelectorAll('.table-row-checkbox').forEach(cb => cb.checked = checked);
    updateTableSelectState();
}

function updateTableSelectState() {
    const all = document.querySelectorAll('.table-row-checkbox');
    const checked = document.querySelectorAll('.table-row-checkbox:checked').length;
    const selectAll = document.getElementById('table-select-all');
    selectAll.checked = all.length > 0 && checked === all.length;
    selectAll.indeterminate = checked > 0 && checked < all.length;
    handleCheckboxChange();
}

// === Card View ===
function renderConfig() {
    apiConfigsContainer.innerHTML = '';
    const batchSection = document.getElementById('batch-actions-section');
    const batchMoveSelect = document.getElementById('batch-move-group-select');

    batchMoveSelect.innerHTML = '<option value="" selected disabled>选择目标分组...</option><option value="默认分组">默认分组</option>';

    const apiUrls = currentConfigData.apiUrls || {};
    const groupedEndpoints = {};
    const allGroups = new Set(['默认分组']);

    for (const apiKey in apiUrls) {
        const group = apiUrls[apiKey].group || '默认分组';
        allGroups.add(group);
        if (!groupedEndpoints[group]) groupedEndpoints[group] = [];
        groupedEndpoints[group].push({ key: apiKey, config: apiUrls[apiKey] });
    }

    Array.from(allGroups).sort().forEach(g => { if (g !== '默认分组') batchMoveSelect.add(new Option(g, g)); });

    const sortedGroups = Object.keys(groupedEndpoints).sort((a, b) => {
        const order = { '通用转发': 1, 'AI绘图': 2, '二次元图片': 3, '三次元图片': 4, '表情包': 5, '默认分组': 99 };
        return (order[a] || 50) - (order[b] || 50);
    });

    batchSection.style.display = 'block';

    if (Object.keys(apiUrls).length === 0) {
        apiConfigsContainer.innerHTML = '<div class="alert alert-info">当前没有配置任何 API 端点。点击"添加新 API 端点"开始。</div>';
    } else {
        sortedGroups.forEach(groupName => {
            const container = document.createElement('div');
            container.id = `group-${groupName.replace(/\s+/g, '-')}`;

            const title = document.createElement('h2');
            title.className = 'group-title d-flex align-items-center';
            title.innerHTML = `<input type="checkbox" class="form-check-input me-2 group-select-all-checkbox" onchange="toggleSelectGroup(this, '${groupName}')"> ${groupName}`;
            container.appendChild(title);

            groupedEndpoints[groupName].sort((a, b) => a.key.localeCompare(b.key));
            groupedEndpoints[groupName].forEach(item => container.appendChild(renderApiEndpoint(item.key, item.config)));

            apiConfigsContainer.appendChild(container);
        });
    }
}

function renderApiEndpoint(apiKey, config) {
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('data-api-key', apiKey);

    card.innerHTML = `
        <div class="card-header">
            <div class="d-flex align-items-center">
                <input class="form-check-input me-2 endpoint-checkbox" type="checkbox" value="${apiKey}" onchange="handleCheckboxChange()">
                <span>端点: /<input type="text" value="${apiKey}" class="api-key-input" placeholder="路径名" required></span>
            </div>
            <button type="button" class="btn btn-danger btn-sm" onclick="removeApiEndpoint(this.closest('.card'))"><i class="bi bi-trash"></i> 删除</button>
        </div>
        <div class="card-body">
            <div class="row mb-3"><label class="col-sm-3 col-form-label text-sm-end">分组:</label><div class="col-sm-9"><input type="text" class="form-control" id="${apiKey}-group" value="${config.group || ''}" placeholder="例如: AI绘图"></div></div>
            <div class="row mb-3"><label class="col-sm-3 col-form-label text-sm-end">类型:</label><div class="col-sm-9"><select class="form-select" id="${apiKey}-type"><option value="image" ${config.type !== 'video' ? 'selected' : ''}>图片</option><option value="video" ${config.type === 'video' ? 'selected' : ''}>视频</option></select></div></div>
            <div class="row mb-3"><label class="col-sm-3 col-form-label text-sm-end">描述:</label><div class="col-sm-9"><textarea class="form-control" id="${apiKey}-description" placeholder="API 用途说明">${config.description || ''}</textarea></div></div>
            <div class="row mb-3"><label class="col-sm-3 col-form-label text-sm-end">目标 URL:</label><div class="col-sm-9"><input type="url" class="form-control" id="${apiKey}-url" value="${config.url || ''}" placeholder="https://api.example.com" required></div></div>
            <div class="row mb-3"><label class="col-sm-3 col-form-label text-sm-end">处理方式:</label><div class="col-sm-9"><select class="form-select" id="${apiKey}-method" onchange="toggleProxySettings(this, '${apiKey}')"><option value="redirect" ${config.method !== 'proxy' ? 'selected' : ''}>重定向 (302)</option><option value="proxy" ${config.method === 'proxy' ? 'selected' : ''}>代理请求</option></select></div></div>
            
            <div class="proxy-settings" id="${apiKey}-proxy-settings" style="display:${config.method === 'proxy' ? 'block' : 'none'}">
                <h5>代理设置</h5>
                <div class="row mb-3"><label class="col-sm-3 col-form-label text-sm-end">图片链接字段:</label><div class="col-sm-9"><input type="text" class="form-control" id="${apiKey}-imageUrlField" value="${config.proxySettings?.imageUrlField || ''}" placeholder="例如: data.url"></div></div>
                <div class="row mb-3"><label class="col-sm-3 col-form-label text-sm-end">提取失败时:</label><div class="col-sm-9"><select class="form-select" id="${apiKey}-fallbackAction"><option value="returnJson" ${config.proxySettings?.fallbackAction !== 'error' ? 'selected' : ''}>返回原始 JSON</option><option value="error" ${config.proxySettings?.fallbackAction === 'error' ? 'selected' : ''}>返回错误</option></select></div></div>
            </div>
            
            <div class="query-params">
                <h5>查询参数配置</h5>
                <div id="${apiKey}-params-list"></div>
                <button type="button" class="btn btn-outline-secondary btn-sm mt-2" onclick="addQueryParam('${apiKey}')"><i class="bi bi-plus-circle"></i> 添加参数</button>
            </div>
        </div>`;

    // Render existing query params
    const paramsList = card.querySelector(`#${apiKey}-params-list`);
    (config.queryParams || []).forEach((param, i) => renderQueryParam(paramsList, apiKey, param, i));

    return card;
}

function toggleProxySettings(select, apiKey) {
    document.getElementById(`${apiKey}-proxy-settings`).style.display = select.value === 'proxy' ? 'block' : 'none';
}

function renderQueryParam(container, apiKey, param, index) {
    const div = document.createElement('div');
    div.className = 'param-item';
    const prefix = `${apiKey}-param-${index}`;
    div.innerHTML = `
        <button type="button" class="btn btn-danger btn-sm remove-param-button" onclick="this.closest('.param-item').remove()"><i class="bi bi-x-lg"></i></button>
        <div class="row mb-2"><label class="col-sm-3 col-form-label text-sm-end">参数名:</label><div class="col-sm-9"><input type="text" class="form-control form-control-sm" id="${prefix}-name" value="${param.name || ''}" required placeholder="keyword"></div></div>
        <div class="row mb-2"><label class="col-sm-3 col-form-label text-sm-end">描述:</label><div class="col-sm-9"><textarea class="form-control form-control-sm" id="${prefix}-desc" placeholder="参数说明">${param.description || ''}</textarea></div></div>
        <div class="row mb-2"><label class="col-sm-3 col-form-label text-sm-end">必需:</label><div class="col-sm-9"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="${prefix}-required" ${param.required ? 'checked' : ''}></div></div></div>
        <div class="row mb-2"><label class="col-sm-3 col-form-label text-sm-end">默认值:</label><div class="col-sm-9"><input type="text" class="form-control form-control-sm" id="${prefix}-default" value="${param.defaultValue || ''}" placeholder="可选"></div></div>
        <div class="row mb-2"><label class="col-sm-3 col-form-label text-sm-end">有效值:</label><div class="col-sm-9"><input type="text" class="form-control form-control-sm" id="${prefix}-validValues" value="${(param.validValues || []).join(',')}" placeholder="value1,value2"></div></div>`;
    container.appendChild(div);
}

function addQueryParam(apiKey) {
    const container = document.getElementById(`${apiKey}-params-list`);
    const index = container.querySelectorAll('.param-item').length;
    renderQueryParam(container, apiKey, {}, index);
}

function addApiEndpoint() {
    const newKey = `new_endpoint_${Date.now()}`;
    const newConfig = { group: '默认分组', description: '', url: '', method: 'redirect', queryParams: [], proxySettings: {} };

    if (!apiConfigsContainer.querySelector('.card')) apiConfigsContainer.innerHTML = '';

    let container = apiConfigsContainer.querySelector('#group-默认分组');
    if (!container) {
        const title = document.createElement('h2');
        title.className = 'group-title';
        title.textContent = '默认分组';
        apiConfigsContainer.appendChild(title);
        container = document.createElement('div');
        container.id = 'group-默认分组';
        apiConfigsContainer.appendChild(container);
    }

    const card = renderApiEndpoint(newKey, newConfig);
    container.appendChild(card);
    card.querySelector('.api-key-input').focus({ preventScroll: true });
}

function removeApiEndpoint(card) {
    if (!card) return;
    const apiKey = card.getAttribute('data-api-key');
    delete currentConfigData.apiUrls[apiKey];
    card.remove();
    showMessage(`端点 /${apiKey} 已删除。点击"保存"以确认。`, 'success');
    handleCheckboxChange();
}

function addNewGroup() {
    const name = prompt('请输入新分组名称:', '');
    if (!name?.trim()) return showMessage('分组名称不能为空。', 'error');

    const trimmed = name.trim();
    const id = `group-${trimmed.replace(/\s+/g, '-')}`;
    if (document.getElementById(id)) return showMessage(`分组 "${trimmed}" 已存在。`, 'error');

    const container = document.createElement('div');
    container.id = id;
    const title = document.createElement('h2');
    title.className = 'group-title d-flex align-items-center';
    title.innerHTML = `<input type="checkbox" class="form-check-input me-2 group-select-all-checkbox" onchange="toggleSelectGroup(this, '${trimmed}')"> ${trimmed}`;
    container.appendChild(title);
    apiConfigsContainer.appendChild(container);

    const select = document.getElementById('batch-move-group-select');
    if (!Array.from(select.options).some(o => o.value === trimmed)) {
        select.add(new Option(trimmed, trimmed));
    }

    showMessage(`新分组 "${trimmed}" 已添加。`, 'success');
    title.scrollIntoView({ behavior: 'smooth' });
}

// === Batch Actions ===
function getSelectedApiKeys() {
    const cardKeys = Array.from(document.querySelectorAll('.endpoint-checkbox:checked')).map(cb => cb.value);
    const tableKeys = Array.from(document.querySelectorAll('.table-row-checkbox:checked')).map(cb => cb.value);
    return [...new Set([...cardKeys, ...tableKeys])];
}

function handleCheckboxChange() {
    const selected = getSelectedApiKeys();
    const count = selected.length;
    document.getElementById('selected-count').textContent = count;
    document.getElementById('batch-delete-button').disabled = count === 0;
    document.getElementById('batch-move-button').disabled = count === 0;
    document.getElementById('batch-move-group-select').disabled = count === 0;

    const allCb = apiConfigsContainer.querySelectorAll('.endpoint-checkbox');
    const selectAll = document.getElementById('select-all-checkbox');
    selectAll.checked = allCb.length > 0 && count === allCb.length;
    selectAll.indeterminate = count > 0 && count < allCb.length;
}

function toggleSelectAll(checked) {
    apiConfigsContainer.querySelectorAll('.endpoint-checkbox').forEach(cb => cb.checked = checked);
    handleCheckboxChange();
}

function toggleSelectGroup(checkbox, groupName) {
    const container = document.getElementById(`group-${groupName.replace(/\s+/g, '-')}`);
    if (container) container.querySelectorAll('.endpoint-checkbox').forEach(cb => cb.checked = checkbox.checked);
    handleCheckboxChange();
}

function batchDeleteEndpoints() {
    const keys = getSelectedApiKeys();
    if (!keys.length) return showMessage('请先选择要删除的端点。', 'error');

    keys.forEach(apiKey => {
        delete currentConfigData.apiUrls[apiKey];
        document.querySelector(`.card[data-api-key="${apiKey}"]`)?.remove();
        document.querySelector(`tr[data-api-key="${apiKey}"]`)?.remove();
    });

    handleCheckboxChange();
    showMessage(`已删除 ${keys.length} 个端点。点击"保存"以确认。`, 'success');
}

function batchMoveGroup() {
    const keys = getSelectedApiKeys();
    const target = document.getElementById('batch-move-group-select').value;
    if (!keys.length) return showMessage('请先选择端点。', 'error');
    if (!target) return showMessage('请选择目标分组。', 'error');

    keys.forEach(apiKey => {
        const input = document.querySelector(`#${apiKey}-group`);
        if (input) input.value = target;
    });

    // Collect current form data and re-render
    const formData = collectFormData();
    currentConfigData.apiUrls = formData.apiUrls;
    renderConfig();
    keys.forEach(apiKey => {
        const cb = apiConfigsContainer.querySelector(`.endpoint-checkbox[value="${apiKey}"]`);
        if (cb) cb.checked = true;
    });
    handleCheckboxChange();
    showMessage(`已将 ${keys.length} 个端点移至 "${target}"。点击"保存"以确认。`, 'success');
}

function collectFormData() {
    const updatedApiUrls = {};
    document.querySelectorAll('.card[data-api-key]').forEach(card => {
        const apiKeyInput = card.querySelector('.api-key-input');
        const apiKey = sanitizeApiKey(apiKeyInput.value.trim());
        const original = card.getAttribute('data-api-key');
        if (!apiKey) return;

        updatedApiUrls[apiKey] = {
            group: card.querySelector(`#${original}-group`).value.trim() || '默认分组',
            description: card.querySelector(`#${original}-description`).value.trim(),
            url: card.querySelector(`#${original}-url`).value.trim(),
            type: card.querySelector(`#${original}-type`).value,
            method: card.querySelector(`#${original}-method`).value,
            queryParams: [],
            proxySettings: {}
        };
    });
    return { apiUrls: updatedApiUrls };
}

// === Load & Save ===
async function loadConfig() {
    try {
        const response = await fetch('/config', { credentials: 'same-origin' });
        if (response.status === 401) return window.location.href = '/admin-login';
        currentConfigData = await response.json();
        if (!currentConfigData.apiUrls) currentConfigData.apiUrls = {};
        renderConfig();
        handleCheckboxChange();
    } catch (error) {
        console.error('加载配置失败:', error);
        showMessage('加载配置失败: ' + error.message, 'error');
    }
}

async function saveConfig(event) {
    event.preventDefault();
    let updatedApiUrls = {};
    let hasError = false;

    if (currentView === 'table') {
        // Validate table data
        for (const apiKey in currentConfigData.apiUrls) {
            if (!apiKey || apiKey.startsWith('new_')) {
                showMessage('错误：发现未命名的端点！', 'error');
                return;
            }
            if (!currentConfigData.apiUrls[apiKey].url) {
                showMessage(`错误：端点 /${apiKey} 的 URL 不能为空！`, 'error');
                return;
            }
        }
        updatedApiUrls = currentConfigData.apiUrls;
    } else {
        // Collect from card view
        const cards = apiConfigsContainer.querySelectorAll('.card[data-api-key]');
        const usedKeys = new Set();

        for (const card of cards) {
            if (hasError) break;
            const apiKeyInput = card.querySelector('.api-key-input');
            const apiKey = sanitizeApiKey(apiKeyInput.value.trim());
            const original = card.getAttribute('data-api-key');

            if (!apiKey) { showMessage('错误：发现空端点名！', 'error'); apiKeyInput.focus(); hasError = true; break; }
            if (usedKeys.has(apiKey)) { showMessage(`错误：端点 /${apiKey} 重复！`, 'error'); apiKeyInput.focus(); hasError = true; break; }
            usedKeys.add(apiKey);

            const urlInput = card.querySelector(`#${original}-url`);
            if (!urlInput.value.trim()) { showMessage(`错误：端点 /${apiKey} 的 URL 不能为空！`, 'error'); urlInput.focus(); hasError = true; break; }

            const entry = {
                group: card.querySelector(`#${original}-group`).value.trim() || '默认分组',
                description: card.querySelector(`#${original}-description`).value.trim(),
                url: urlInput.value.trim(),
                type: card.querySelector(`#${original}-type`).value,
                method: card.querySelector(`#${original}-method`).value,
                queryParams: [],
                proxySettings: {}
            };

            // Collect query params
            card.querySelectorAll(`#${original}-params-list .param-item`).forEach(item => {
                const name = item.querySelector('[id$="-name"]').value.trim();
                if (!name) return;
                entry.queryParams.push({
                    name,
                    description: item.querySelector('[id$="-desc"]').value.trim(),
                    required: item.querySelector('[id$="-required"]').checked,
                    defaultValue: item.querySelector('[id$="-default"]').value.trim() || undefined,
                    validValues: item.querySelector('[id$="-validValues"]').value.trim().split(',').filter(Boolean) || undefined
                });
            });

            // Collect proxy settings
            if (entry.method === 'proxy') {
                const field = card.querySelector(`#${original}-imageUrlField`)?.value.trim();
                const fallback = card.querySelector(`#${original}-fallbackAction`)?.value;
                if (field) entry.proxySettings.imageUrlField = field;
                entry.proxySettings.fallbackAction = fallback || 'returnJson';
            }

            // Preserve special fields from original config
            const originalConfig = currentConfigData.apiUrls[original];
            if (originalConfig?.urlConstruction) entry.urlConstruction = originalConfig.urlConstruction;
            if (originalConfig?.modelName) entry.modelName = originalConfig.modelName;

            updatedApiUrls[apiKey] = entry;
        }
    }

    if (hasError) return;

    const saveBtn = form.querySelector('.save-button');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 保存中...';

    try {
        const response = await fetch('/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiUrls: updatedApiUrls, baseTag: '' }),
            credentials: 'same-origin'
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        showMessage(result.message || '配置已保存！', 'success');
        await loadConfig();
    } catch (error) {
        showMessage('保存失败: ' + error.message, 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="bi bi-save"></i> 保存所有配置';
    }
}

// === Initialize ===
form.addEventListener('submit', saveConfig);
document.addEventListener('DOMContentLoaded', loadConfig);
