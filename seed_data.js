const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'config.db');
const db = new Database(dbPath);

const endpoints = [
    { key: 'ycy', group: '默认分组', description: '二次元自适应', url: 'https://t.alcy.cc/ycy', method: 'redirect', type: 'image' },
    { key: 'moez', group: '默认分组', description: '萌版自适应', url: 'https://t.alcy.cc/moez', method: 'redirect', type: 'image' },
    { key: 'pc', group: '默认分组', description: 'pc横图', url: 'https://t.alcy.cc/pc', method: 'redirect', type: 'image' },
    { key: 'moe', group: '默认分组', description: '萌版横图', url: 'https://t.alcy.cc/moe', method: 'redirect', type: 'image' },
    { key: 'fj', group: '默认分组', description: '风景横图', url: 'https://t.alcy.cc/fj', method: 'redirect', type: 'image' },
    { key: 'acg', group: '默认分组', description: 'acg动图', url: 'https://t.alcy.cc/acg', method: 'redirect', type: 'video' },
    { key: 'mp', group: '默认分组', description: '移动竖图', url: 'https://t.alcy.cc/mp', method: 'redirect', type: 'image' },
    { key: 'moemp', group: '默认分组', description: '萌版竖图', url: 'https://t.alcy.cc/moemp', method: 'redirect', type: 'image' },
    { key: 'tx', group: '默认分组', description: '头像', url: 'https://t.alcy.cc/tx', method: 'redirect', type: 'image' },
    { key: 'lai', group: '默认分组', description: '随机风景', url: 'https://t.alcy.cc/lai', method: 'redirect', type: 'image' },
    { key: 'tianmei', group: '默认分组', description: '甜妹视频', url: 'https://v2.api-m.com/api/meinv?return=302', method: 'redirect', type: 'video' },
    { key: 'heisivideo', group: '默认分组', description: '白丝视频', url: 'http://api.yujn.cn/api/baisis.php', method: 'redirect', type: 'video' },
    { key: 'baisivideo', group: '默认分组', description: '黑丝视频', url: 'http://api.yujn.cn/api/heisis.php', method: 'redirect', type: 'video' },
];

const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO api_endpoints (
        api_key, group_name, description, url, method, type, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
`);

const insertAll = db.transaction(() => {
    for (const ep of endpoints) {
        insertStmt.run(ep.key, ep.group, ep.description, ep.url, ep.method, ep.type);
        console.log(`Inserted: ${ep.key}`);
    }
});

try {
    insertAll();
    console.log(`\n✅ Successfully inserted ${endpoints.length} endpoints.`);
} catch (error) {
    console.error('Error:', error.message);
} finally {
    db.close();
}
