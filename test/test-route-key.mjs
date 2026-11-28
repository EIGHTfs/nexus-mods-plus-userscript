/**
 * 站内路由键测试。
 *
 * ctxKey 是路由接管的核心判据：它决定「当前页面算不算换了一页」。
 * 判错会导致两种误伤——该重挂时不重挂（面板还是上一页的），
 * 或不该重挂时反复重挂（面板闪烁、批量队列被打断）。
 *
 * 运行：node test/test-route-key.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'nexus-mods-plus.user.js'), 'utf8');

function extractFunction(name) {
    const marker = 'function ' + name + '(';
    const start = source.indexOf(marker);
    if (start < 0) throw new Error('源码里找不到函数：' + name);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error('函数体没有闭合：' + name);
}

const context = vm.createContext({});
vm.runInContext(extractFunction('ctxKey'), context);
const { ctxKey } = context;

const results = [];
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, ok });
    console.log((ok ? '✅ ' : '❌ ') + name);
    if (!ok) console.log('   实际: ' + JSON.stringify(actual) + '\n   期望: ' + JSON.stringify(expected));
}

/* ---------- 详情页：按 modId 区分，不同 mod 必须得到不同键 ---------- */
check('详情页：同一 mod 键相同',
    [ctxKey({ mode: 'detail', domain: 'g1', modId: 22 }), ctxKey({ mode: 'detail', domain: 'g1', modId: 22 })],
    ['detail:g1:22', 'detail:g1:22']);
check('详情页：不同 mod 键不同（这条保证从 A 跳到 B 会重挂）',
    ctxKey({ mode: 'detail', domain: 'g1', modId: 22 }) !== ctxKey({ mode: 'detail', domain: 'g1', modId: 23 }),
    true);
check('详情页：不同游戏下同名 modId 键不同',
    ctxKey({ mode: 'detail', domain: 'g1', modId: 22 }) !== ctxKey({ mode: 'detail', domain: 'g2', modId: 22 }),
    true);

/* ---------- 合集页：按 slug 区分 ---------- */
check('合集页：键含 slug',
    ctxKey({ mode: 'collection', domain: 'g1', collectionSlug: 'my-pack' }),
    'collection:g1:my-pack');
check('合集页：不同 slug 键不同',
    ctxKey({ mode: 'collection', domain: 'g1', collectionSlug: 'a' }) !== ctxKey({ mode: 'collection', domain: 'g1', collectionSlug: 'b' }),
    true);

/* ---------- 列表/搜索：同一游戏下键稳定（不该反复重挂） ---------- */
check('列表页：同游戏键相同',
    ctxKey({ mode: 'list', domain: 'g1' }),
    ctxKey({ mode: 'list', domain: 'g1' }));
check('列表页：不同游戏键不同',
    ctxKey({ mode: 'list', domain: 'g1' }) !== ctxKey({ mode: 'list', domain: 'g2' }),
    true);
check('搜索页：键为 search:',
    ctxKey({ mode: 'search' }),
    'search:');

/* ---------- 类型不同必须视为不同页 ---------- */
check('详情页与合集页键不同',
    ctxKey({ mode: 'detail', domain: 'g1', modId: 1 }) !== ctxKey({ mode: 'collection', domain: 'g1', collectionSlug: '1' }),
    true);

/* ---------- 边界 ---------- */
check('空 ctx：键为 none', ctxKey(null), 'none');
check('字段缺失不崩（domain 缺省为空）',
    ctxKey({ mode: 'detail', modId: 5 }),
    'detail::5');

const failed = results.filter((r) => !r.ok);
console.log('\n结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
process.exit(failed.length ? 1 : 0);
