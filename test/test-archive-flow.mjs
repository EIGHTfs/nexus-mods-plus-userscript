/**
 * 归档下载流程集成测试。
 *
 * 纯函数测试只能证明单个函数对；这里把 archiveDownload 整段抽出来跑，
 * 只把「真正落到浏览器」的两个动作（解析直链、GM_download）换成桩，
 * 验证最终拼出来的路径到底是不是 <Mod名>/<文件名>、图片有没有进同一个目录、
 * 单张图失败会不会把整个下载打断。
 *
 * 运行：node test/test-archive-flow.mjs
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
    // 必须把 async 前缀一起切出来：只取 "function xxx(" 会让函数里的 await 变成语法错误
    const prefixStart = source.lastIndexOf('async ', start);
    const from = (prefixStart >= 0 && start - prefixStart === 'async '.length) ? prefixStart : start;
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return source.slice(from, i + 1);
        }
    }
    throw new Error('函数体没有闭合：' + name);
}

function extractConstLine(fragment) {
    const idx = source.indexOf(fragment);
    if (idx < 0) throw new Error('源码里找不到常量：' + fragment);
    return source.slice(idx, source.indexOf('\n', idx));
}

const consts = [
    'const DL_FOLDER_BAD',
    'const DL_FOLDER_MAX',
    'const DL_FILE_NAME_MAX',
    'const DL_IMG_GAP_MS',
    'const DL_IMG_EXT',
    'const DL_FILE_EXT'
].map(extractConstLine).join('\n');

// 这些是真实实现；resolveWithRetry / gmDownloadTo 稍后用桩覆盖
const realHelpers = [
    'sanitizeFolderName',
    'sanitizeFileName',
    'fileNameFromUrl',
    'pickDownloadFileName',
    'collectImagesFromDom',
    'collectArchiveImages'
].map(extractFunction).join('\n\n');

const target = extractFunction('archiveDownload');

const domStub = {
    document: {
        querySelectorAll(selector) {
            if (selector.indexOf('thumbgallery') < 0) return [];
            return [
                { getAttribute: (n) => (n === 'data-src' ? 'https://staticdelivery.nexusmods.com/mods/5577/images/868/868-1.png' : null) },
                { getAttribute: (n) => (n === 'data-src' ? 'https://staticdelivery.nexusmods.com/mods/5577/images/868/868-2.png' : null) },
                { getAttribute: (n) => (n === 'data-src' ? 'https://staticdelivery.nexusmods.com/mods/5577/images/868/868-3.png' : null) }
            ];
        }
    }
};

const results = [];
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, ok });
    console.log((ok ? '✅ ' : '❌ ') + name);
    if (!ok) console.log('   实际: ' + JSON.stringify(actual) + '\n   期望: ' + JSON.stringify(expected));
}

/** 每次跑一遍流程，返回记录到的下载调用 */
async function runFlow(options) {
    const calls = [];
    const logs = [];
    const context = vm.createContext({
        URL,
        console,
        document: domStub.document,
        CFG: Object.assign({ dlImagesWithMod: true, dlImgLimit: 12 }, options.cfg || {}),
        sleep: async () => {},
        // 桩：直链解析结果由用例决定
        resolveWithRetry: async () => options.directUrl,
        // 桩：archiveDownload 现在统一走 archivePutFile（内部再选 FS / GM_download 通道）
        archivePutFile: async (folder, fileName, url) => {
            if (options.failOn && options.failOn(url)) throw new Error('浏览器拒绝下载：模拟失败');
            calls.push(folder + '/' + fileName);
            return 'gm';
        },
        // 进度节流与体积格式化在流程里会用到，桩掉避免拖进无关依赖
        dlThrottledProgress: (render) => render,
        fmtSize: (bytes) => String(bytes) + ' B'
    });
    vm.runInContext(consts + '\n' + realHelpers + '\n' + target, context);
    const result = await context.archiveDownload(Object.assign({
        domain: 'snowbreakcontainmentzone',
        modId: 868,
        fileId: 1902,
        gameId: 5577,
        ctxMode: 'detail',
        log: (text, kind) => logs.push((kind || '') + ':' + text)
    }, options.opts || {}));
    return { calls, logs, result };
}

// ---------- 用例 1：常规 mod，标题含斜杠与冒号 ----------
{
    const { calls, result } = await runFlow({
        directUrl: 'https://supporter-files.nexus-cdn.com/5577/868/Siris%20Drift-868-1-0-1760599327.zip?md5=abc',
        opts: { modTitle: 'Siris/FreeFin:Azure Drift', fileName: 'Siris-FreeFin_Azure Drift_a little naughty' }
    });
    check('用例1：目录名清洗后不再含 / 与 :',
        result.folder,
        'Siris_FreeFin_Azure Drift');
    check('用例1：mod 落盘路径 = <Mod名>/<直链文件名>',
        calls[0],
        'Siris_FreeFin_Azure Drift/Siris Drift-868-1-0-1760599327.zip');
    check('用例1：3 张图片都进同一目录',
        calls.slice(1),
        [
            'Siris_FreeFin_Azure Drift/868-1.png',
            'Siris_FreeFin_Azure Drift/868-2.png',
            'Siris_FreeFin_Azure Drift/868-3.png'
        ]);
    check('用例1：图片计数正确', result.images, 3);
}

// ---------- 用例 2：单张图失败不打断整体 ----------
{
    const { calls, result } = await runFlow({
        directUrl: 'https://cdn.example.com/x/Mod-1-0.zip',
        opts: { modTitle: 'Mod', fileName: 'Mod' },
        failOn: (url) => url.indexOf('868-2.png') >= 0
    });
    check('用例2：失败的那张图不记录，其余照下',
        calls,
        ['Mod/Mod-1-0.zip', 'Mod/868-1.png', 'Mod/868-3.png']);
    check('用例2：成功计数 = 2', result.images, 2);
}

// ---------- 用例 3：关闭图片下载 ----------
{
    const { calls, result } = await runFlow({
        directUrl: 'https://cdn.example.com/x/Mod-1-0.zip',
        opts: { modTitle: 'Mod', fileName: 'Mod' },
        cfg: { dlImagesWithMod: false }
    });
    check('用例3：只下 mod，不请求图片', calls, ['Mod/Mod-1-0.zip']);
    check('用例3：图片计数 0', result.images, 0);
}

// ---------- 用例 4：mod 名超长 + 结尾带点（Windows 建目录会失败的情况） ----------
{
    const longName = '很长的名字'.repeat(30) + '...';
    const { result } = await runFlow({
        directUrl: 'https://cdn.example.com/x/a.zip',
        opts: { modTitle: longName, fileName: 'a.zip' },
        cfg: { dlImagesWithMod: false }
    });
    check('用例4：目录名截断到 80 且不以点结尾',
        [result.folder.length, /\.$/.test(result.folder)],
        [80, false]);
}

// ---------- 用例 5：合集模式只用封面，不抓详情页图库 ----------
{
    const { calls } = await runFlow({
        directUrl: 'https://cdn.example.com/x/b.zip',
        opts: {
            modTitle: 'Other Mod',
            fileName: 'b',
            ctxMode: 'collection',
            pictureUrl: 'https://staticdelivery.nexusmods.com/mods/5577/images/999/999-cover.jpeg'
        }
    });
    check('用例5：合集只下封面一张，不误用当前页图库',
        calls,
        ['Other Mod/b.zip', 'Other Mod/999-cover.jpeg']);
}

// ---------- 用例 6：图片数量上限生效 ----------
{
    const { calls } = await runFlow({
        directUrl: 'https://cdn.example.com/x/c.zip',
        opts: { modTitle: 'Cap', fileName: 'c' },
        cfg: { dlImgLimit: 2 }
    });
    check('用例6：上限 2 张时只请求 2 张图', calls.length, 3);
}

// ---------- 用例 7：独立按钮语义（forceImages 覆盖 CFG 的「附带图片=关」） ----------
{
    const { calls } = await runFlow({
        directUrl: 'https://cdn.example.com/x/d.zip',
        opts: { modTitle: 'Force', fileName: 'd', forceImages: true },
        cfg: { dlImagesWithMod: false }
    });
    check('用例7：forceImages 时即使关闭附带图片也会下图',
        calls,
        ['Force/d.zip', 'Force/868-1.png', 'Force/868-2.png', 'Force/868-3.png']);
}

const failed = results.filter((r) => !r.ok);
console.log('\n结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
process.exit(failed.length ? 1 : 0);
