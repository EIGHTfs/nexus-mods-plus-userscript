/**
 * 文件行 HTML 生成测试（面板渲染的可测部分）。
 *
 * buildFileRowHtml 是纯函数：给定文件数据与已下载集合，返回一段 HTML。
 * 面板渲染把它抽出来，正是为了让这部分能被单测覆盖——面板整体是 DOM 操作，
 * 没有浏览器就没法测，但「渲染出什么」是可以脱离环境断言的。
 *
 * 运行：node test/test-file-row.mjs
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

const code = ['escapeHtml', 'fmtSize', 'fmtNum', 'normalizeFileName', 'isFileDownloaded', 'buildFileRowHtml']
    .map(extractFunction).join('\n\n');
const context = vm.createContext({});
vm.runInContext(code, context);
const { buildFileRowHtml } = context;

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log((ok ? '✅ ' : '❌ ') + name);
    if (!ok && detail) console.log('   ' + detail);
}

const none = { byFileId: {}, byName: {} };
const doneFirst = { byFileId: { '11': true }, byName: {} };

/* ---------- 基本结构 ---------- */
{
    const html = buildFileRowHtml({ fileId: 11, name: 'File.zip', version: '1.0', sizeInBytes: 1024 }, 0, none);
    check('结构：含行容器与主体', html.includes('class="nme-dl-row"') && html.includes('class="nme-dl-main"'));
    check('结构：含下载按钮且带序号', html.includes('data-idx="0"') && html.includes('一键下载'));
    check('结构：元信息拼接版本与大小', html.includes('版本 1.0') && html.includes('1.0KB'),
        '实际片段: ' + html.slice(0, 200));
}

/* ---------- 已下载徽章 ---------- */
{
    const withBadge = buildFileRowHtml({ fileId: 11, name: 'File.zip' }, 0, doneFirst);
    const noBadge = buildFileRowHtml({ fileId: 12, name: 'Other.zip' }, 1, doneFirst);
    check('徽章：已下载文件带「已下载」', withBadge.includes('nme-dl-done') && withBadge.includes('已下载'));
    check('徽章：未下载文件不带', !noBadge.includes('nme-dl-done'));
}

/* ---------- 分类标签 ---------- */
{
    const html = buildFileRowHtml({ fileId: 1, name: 'A.zip', category: 'MAIN' }, 0, none);
    check('标签：有分类时渲染 nme-dl-tag', html.includes('nme-dl-tag') && html.includes('MAIN'));
    const noTag = buildFileRowHtml({ fileId: 1, name: 'A.zip' }, 0, none);
    check('标签：无分类时不渲染', !noTag.includes('nme-dl-tag'));
}

/* ---------- 转义（防注入） ---------- */
{
    const html = buildFileRowHtml({ fileId: 1, name: '<img src=x onerror=alert(1)>.zip' }, 0, none);
    check('转义：文件名中的尖括号被转义', !html.includes('<img src=x') && html.includes('&lt;img'));
    const cat = buildFileRowHtml({ fileId: 1, name: 'a.zip', category: '<script>' }, 0, none);
    check('转义：分类同样转义', !cat.includes('<script>'));
}

/* ---------- 边界 ---------- */
{
    const noName = buildFileRowHtml({ fileId: 77 }, 3, none);
    check('边界：无文件名时用「文件 #id」兜底', noName.includes('文件 #77'));
    check('边界：无版本/大小/下载数时元信息为空不报错',
        (() => { try { buildFileRowHtml({ fileId: 1, name: 'a.zip' }, 0, none); return true; } catch (e) { return false; } })());
    const zeros = buildFileRowHtml({ fileId: 1, name: 'a.zip', totalDownloads: 0 }, 0, none);
    check('边界：下载数为 0 也要显示', zeros.includes('下载 0'));
}

const failed = results.filter((r) => !r.ok);
console.log('\n结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
process.exit(failed.length ? 1 : 0);
