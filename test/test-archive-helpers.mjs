/**
 * 归档下载纯函数测试。
 *
 * 为什么要「从源文件抽函数」而不是复制一份实现：
 *   复制会让测试和真实代码变成两份真相，改了源文件测试照样绿。
 *   这里用括号配平把源文件里的函数原文切出来，在 vm 里执行，
 *   测的就是脚本运行时真正会跑的那段代码。
 *
 * 运行：node test/test-archive-helpers.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, '..', 'nexus-mods-plus.user.js');
const source = fs.readFileSync(scriptPath, 'utf8');

/** 从源码里切出 `function name(...) { ... }` 的完整原文（按花括号配平） */
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

/** 把常量声明也切出来（正则字面量在函数里用到） */
function extractConstLine(fragment) {
    const idx = source.indexOf(fragment);
    if (idx < 0) throw new Error('源码里找不到常量：' + fragment);
    const end = source.indexOf('\n', idx);
    return source.slice(idx, end);
}

const consts = [
    'const DL_FOLDER_BAD',
    'const DL_FOLDER_MAX',
    'const DL_FILE_NAME_MAX',
    'const DL_IMG_EXT',
    'const DL_FILE_EXT'
].map(extractConstLine).join('\n');

const functions = [
    'sanitizeFolderName',
    'sanitizeFileName',
    'fileNameFromUrl',
    'pickDownloadFileName',
    'collectImagesFromDom',
    'dlResolveFinalFileName',
    'dlDispositionFileName',
    'dlPickFileNameFromParts',
    'dlTotalFromContentRange',
    'dlStartFromContentRange'
].map(extractFunction).join('\n\n');

/** 最小 DOM 桩：只提供 collectImagesFromDom 用到的那点能力 */
const domStub = {
    document: {
        querySelectorAll(selector) {
            if (selector.indexOf('thumbgallery') < 0) return [];
            // 还原真实页面结构：原图在 data-src，img.src 是 thumbnails/ 缩略图
            return [
                { getAttribute: (n) => (n === 'data-src' ? 'https://staticdelivery.nexusmods.com/mods/5577/images/868/868-1760599327-512078410.png' : null) },
                { getAttribute: (n) => (n === 'data-src' ? 'https://staticdelivery.nexusmods.com/mods/5577/images/868/868-1760599338-1231626948.png' : null) },
                { getAttribute: (n) => (n === 'data-src' ? 'https://staticdelivery.nexusmods.com/mods/5577/images/thumbnails/868/868-1760599349-974354724.png' : null) },
                { getAttribute: (n) => (n === 'data-src' ? 'data:image/gif;base64,R0lGOD' : null) },
                { getAttribute: (n) => (n === 'data-src' ? 'https://staticdelivery.nexusmods.com/mods/5577/images/868/868-1760599327-512078410.png' : null) }
            ];
        }
    }
};

const context = vm.createContext({ URL, document: domStub.document, console });
vm.runInContext(consts + '\n' + functions, context);

const results = [];
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, ok, actual, expected });
    if (!ok) console.log('❌ ' + name + '\n   实际: ' + JSON.stringify(actual) + '\n   期望: ' + JSON.stringify(expected));
    else console.log('✅ ' + name);
}

const { sanitizeFolderName, sanitizeFileName, fileNameFromUrl, pickDownloadFileName, collectImagesFromDom } = context;

// ---------- 目录名 ----------
check('目录名：常规 mod 标题原样保留',
    sanitizeFolderName('Siris-FreeFin_Azure Drift(cos2)_a little naughty'),
    'Siris-FreeFin_Azure Drift(cos2)_a little naughty');
check('目录名：斜杠与冒号必须被替换（否则会多建一层目录）',
    sanitizeFolderName('a/b:c*d?"e"<f>|g'),
    'a_b_c_d__e__f__g');
check('目录名：首尾的点与空格去掉（Windows 不允许结尾点）',
    sanitizeFolderName('  ..名字..  '),
    '名字');
check('目录名：空值走 fallback',
    sanitizeFolderName('', 'mod-868'),
    'mod-868');
check('目录名：纯非法字符也要有兜底',
    sanitizeFolderName('///', 'mod-1'),
    '___');
check('目录名：超长截断到 80',
    sanitizeFolderName('长'.repeat(200)).length,
    80);

// ---------- 文件名 ----------
check('文件名：超长时保住扩展名',
    sanitizeFileName('a'.repeat(300) + '.zip').endsWith('.zip'),
    true);
check('文件名：超长时总长不超过 120',
    sanitizeFileName('a'.repeat(300) + '.zip').length,
    120);
check('文件名：空值兜底',
    sanitizeFileName('', 'file.zip'),
    'file.zip');

// ---------- 直链取文件名 ----------
check('直链：解码 %20 并去掉查询串',
    fileNameFromUrl('https://supporter-files.nexus-cdn.com/5577/868/Siris%20Drift-868-1-0-1760599327.zip?md5=abc&expires=1'),
    'Siris Drift-868-1-0-1760599327.zip');
check('直链：非法 URL 返回空串',
    fileNameFromUrl('not-a-url'),
    '');

// ---------- 落盘文件名三级兜底 ----------
const cdnUrl = 'https://supporter-files.nexus-cdn.com/5577/868/Siris%20Drift-868-1-0-1760599327.zip?md5=abc';
check('文件名：声明名无扩展名 → 用直链末段（Nexus 真实情况）',
    pickDownloadFileName({ name: 'Siris-FreeFin_Azure Drift_a little naughty' }, cdnUrl, 'Siris'),
    'Siris Drift-868-1-0-1760599327.zip');
check('文件名：声明名带扩展名 → 直接用声明名',
    pickDownloadFileName({ name: 'Patch v2.7z' }, cdnUrl, 'Siris'),
    'Patch v2.7z');
check('文件名：两边都没扩展名 → 用 Nexus 文件标题 + .zip（不再拼 mod 标题与版本）',
    pickDownloadFileName({ name: 'NoExt', version: '1.0' }, 'https://cdn.example.com/downloads/1902', 'Siris'),
    'NoExt.zip');
check('文件名：直链末段带扩展名时直接用直链名',
    pickDownloadFileName({ name: 'SomeFile' }, 'https://cdn.example.com/x/abc.7z', 'Siris'),
    'abc.7z');

// ---------- 图片收集 ----------
const images = collectImagesFromDom();
check('图片：只收原图，去掉缩略图/data URI/重复项',
    images,
    [
        'https://staticdelivery.nexusmods.com/mods/5577/images/868/868-1760599327-512078410.png',
        'https://staticdelivery.nexusmods.com/mods/5577/images/868/868-1760599338-1231626948.png'
    ]);

// ---------- 最终文件名解析（Nexus 真实名只在重定向后出现） ----------
const { dlResolveFinalFileName } = context;
function fakeResponse(headers, finalUrl) {
    return { headers: { get: (name) => (name.toLowerCase() === 'content-disposition' ? headers : null) }, url: finalUrl };
}
check('定名：Content-Disposition 优先',
    dlResolveFinalFileName(
        fakeResponse('attachment; filename="Enya_Tempest(default)_a little naughty-868-1-2-1762417842.zip"',
            'https://cdn.example.com/x/other-name.bin'),
        'fallback.zip'),
    'Enya_Tempest(default)_a little naughty-868-1-2-1762417842.zip');
check('定名：没有 CD 头时用重定向后 URL 末段',
    dlResolveFinalFileName(fakeResponse('', 'https://supporter-files.nexus-cdn.com/5577/1056/Enya-868-1-2-1762417842.zip?md5=x'),
        'fallback.zip'),
    'Enya-868-1-2-1762417842.zip');
check('定名：都没有时用调用方提示名',
    dlResolveFinalFileName(fakeResponse('', 'https://www.nexusmods.com/Core/Libs/Common/Widgets/DownloadFile'),
        'Mod-1.zip'),
    'Mod-1.zip');
check('定名：URL 末段无扩展名时不误用',
    dlResolveFinalFileName(fakeResponse('', 'https://www.nexusmods.com/Core/Libs/Common/Widgets/DownloadFile'),
        'Real-868-1-2-1762417842.zip'),
    'Real-868-1-2-1762417842.zip');

// ---------- GM_xhr 兜底通道定名（拿不到 Response 对象，只有头文本 + finalUrl） ----------
const { dlPickFileNameFromParts } = context;
check('兜底定名：从响应头文本取 Content-Disposition 文件名',
    dlPickFileNameFromParts(
        'HTTP/1.1 200 OK\r\nContent-Disposition: attachment; filename="Enya_Tempest-868-1-2-1762417842.zip"\r\n',
        'https://supporter-files.nexus-cdn.com/5577/1056/other.bin',
        'hint.zip'),
    'Enya_Tempest-868-1-2-1762417842.zip');
check('兜底定名：没有 CD 头时用 finalUrl 末段',
    dlPickFileNameFromParts('', 'https://supporter-files.nexus-cdn.com/5577/1056/Enya-868-1-2-1762417842.zip?md5=x', 'hint.zip'),
    'Enya-868-1-2-1762417842.zip');
check('兜底定名：都拿不到才用提示名',
    dlPickFileNameFromParts('', 'https://www.nexusmods.com/Core/Libs/Common/Widgets/DownloadFile', 'Real.zip'),
    'Real.zip');

// ---------- Content-Range 解析（断点续传的起点与总大小） ----------
const { dlTotalFromContentRange, dlStartFromContentRange } = context;
check('Content-Range：解析总大小',
    dlTotalFromContentRange('bytes 0-1023/211334'),
    211334);
check('Content-Range：解析续传起点',
    dlStartFromContentRange('bytes 105667-211333/211334'),
    105667);
check('Content-Range：空值返回 0 / -1（CORS 未暴露该头时的真实情况）',
    [dlTotalFromContentRange(''), dlStartFromContentRange('')],
    [0, -1]);
check('Content-Range：格式异常不崩',
    [dlTotalFromContentRange('garbage'), dlStartFromContentRange('garbage')],
    [0, -1]);

// ---------- 站点真名的 -fileId-版本-时间戳 后缀必须完整保留 ----------
check('文件名：CDN 真名的后缀完整保留（-fileId-版本-时间戳）',
    pickDownloadFileName({ name: 'Shadow_Ka skimpy', version: '1.1' },
        'https://cdn.example.com/5577/22/Shadow_Ka skimpy-716-1-0-1754482857.zip?md5=x',
        'Mauxir'),
    'Shadow_Ka skimpy-716-1-0-1754482857.zip');
check('文件名：兜底名按站点风格拼（文件名-fileId-版本）',
    pickDownloadFileName({ name: 'Shadow_Ka skimpy', version: '1.0.0' },
        'https://www.nexusmods.com/Core/Libs/Common/Widgets/DownloadFile?file_id=41',
        'Mauxir', '', 41),
    'Shadow_Ka skimpy-41-1-0-0.zip');
check('文件名：同名的两个版本兜底名不同（靠 fileId 区分）',
    [
        pickDownloadFileName({ name: 'Same', version: '1.0.0' }, 'https://x/DownloadFile', 'M', '', 41),
        pickDownloadFileName({ name: 'Same', version: '1.1' }, 'https://x/DownloadFile', 'M', '', 1555)
    ],
    ['Same-41-1-0-0.zip', 'Same-1555-1-1.zip']);

const failed = results.filter((r) => !r.ok);
console.log('\n结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
process.exit(failed.length ? 1 : 0);
