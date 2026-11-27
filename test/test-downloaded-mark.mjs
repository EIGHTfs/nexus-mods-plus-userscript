/**
 * 「已下载」标记识别测试。
 *
 * 数据来自 Nexus 文件页的真实结构（文件行里没有 fileId，只有文件名 <p>
 * 与两种已下载信号：li.stat-downloaded、i.material-icons[title*=downloaded]）。
 * 这里只用纯数据喂给判定函数，DOM 解析部分已在浏览器里用真实 HTML 片段验证过。
 *
 * 运行：node test/test-downloaded-mark.mjs
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

const code = ['normalizeFileName', 'isFileDownloaded'].map(extractFunction).join('\n\n');
const context = vm.createContext({});
vm.runInContext(code, context);
const { normalizeFileName, isFileDownloaded } = context;

const results = [];
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, ok });
    console.log((ok ? '✅ ' : '❌ ') + name);
    if (!ok) console.log('   实际: ' + JSON.stringify(actual) + '\n   期望: ' + JSON.stringify(expected));
}

/* ---------- 文件名归一 ---------- */
check('归一：折叠多空格并转小写',
    normalizeFileName('  Mauxir_Shadow   Ka(default)_Sexy Mummy  '),
    'mauxir_shadow ka(default)_sexy mummy');
check('归一：换行与制表也折叠',
    normalizeFileName('A\n\tB'),
    'a b');
check('归一：空值得到空串', normalizeFileName(null), '');

/* ---------- 判定（数据来自真实页面结构） ---------- */
const pageResult = {
    byFileId: {},
    byName: { 'mauxir_shadow ka(default)_sexy mummy': true, 'icon_only_file': true }
};

check('判定：文件名命中 → 已下载',
    isFileDownloaded(pageResult, { fileId: 1902, name: 'Mauxir_Shadow Ka(default)_Sexy Mummy' }),
    true);
check('判定：只有图标信号的文件也算已下载',
    isFileDownloaded(pageResult, { fileId: 1904, name: 'Icon_Only_File' }),
    true);
check('判定：未出现在页面上的文件 → 未下载',
    isFileDownloaded(pageResult, { fileId: 1903, name: 'Another_Not_Downloaded_File' }),
    false);
check('判定：文件名大小写不同也能命中',
    isFileDownloaded(pageResult, { fileId: 1902, name: 'mauxir_shadow ka(default)_sexy mummy' }),
    true);
check('判定：文件名多空格也能命中',
    isFileDownloaded(pageResult, { fileId: 1902, name: 'Mauxir_Shadow  Ka(default)_Sexy Mummy' }),
    true);

/* ---------- fileId 优先级 ---------- */
check('判定：fileId 命中优先于文件名',
    isFileDownloaded({ byFileId: { '1902': true }, byName: {} }, { fileId: 1902, name: '名字对不上' }),
    true);
check('判定：fileId 未命中且文件名为空 → 未下载',
    isFileDownloaded({ byFileId: {}, byName: {} }, { fileId: 9999, name: '' }),
    false);

/* ---------- 边界 ---------- */
check('判定：空集合不崩', isFileDownloaded({ byFileId: {}, byName: {} }, { fileId: 1, name: 'x' }), false);
check('判定：downloaded 为 null 不崩', isFileDownloaded(null, { fileId: 1, name: 'x' }), false);
check('判定：file 为 null 不崩', isFileDownloaded(pageResult, null), false);

const failed = results.filter((r) => !r.ok);
console.log('\n结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
process.exit(failed.length ? 1 : 0);
