/**
 * 切后台暂停/恢复逻辑测试。
 *
 * 覆盖三件事：
 *   1. AbortError 要能被识别出来（否则切后台会被当成网络故障）
 *   2. 普通网络错误不能被误判成中止（否则会无限重试）
 *   3. 被中止后要等回到前台再重试，且重试能成功；真错误必须原样抛出
 *
 * 运行：node test/test-visibility-guard.mjs
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

const code = ['dlIsAbortError', 'dlWaitVisible', 'dlRunWithVisibilityGuard']
    .map(extractFunction).join('\n\n');

const results = [];
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, ok });
    console.log((ok ? '✅ ' : '❌ ') + name);
    if (!ok) console.log('   实际: ' + JSON.stringify(actual) + '\n   期望: ' + JSON.stringify(expected));
}

/* ---------- document 桩：可控制 hidden 并派发 visibilitychange ---------- */
function makeDocument() {
    const listeners = { visibilitychange: [] };
    return {
        hidden: false,
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        removeEventListener(type, fn) {
            listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
        },
        setHidden(value) {
            this.hidden = value;
            (listeners.visibilitychange || []).slice().forEach((fn) => fn());
        },
        listenerCount() { return (listeners.visibilitychange || []).length; }
    };
}

async function makeContext() {
    const documentStub = makeDocument();
    const context = vm.createContext({ document: documentStub, Promise, console });
    vm.runInContext(code, context);
    return { context, documentStub };
}

/* ---------- 1. 错误识别 ---------- */
{
    const { context } = await makeContext();
    const { dlIsAbortError } = context;
    const abortErr = new Error('The operation was aborted.');
    abortErr.name = 'AbortError';

    check('识别：AbortError 判为中止', dlIsAbortError(abortErr), true);
    check('识别：消息含 abort 也算中止',
        dlIsAbortError(new Error('The user aborted a request.')), true);
    check('识别：普通网络错误不算中止',
        dlIsAbortError(new Error('Failed to fetch')), false);
    check('识别：HTTP 错误不算中止',
        dlIsAbortError(new Error('HTTP 403')), false);
    check('识别：null 不崩', dlIsAbortError(null), false);
}

/* ---------- 2. 前台直接成功，不该有任何等待 ---------- */
{
    const { context, documentStub } = await makeContext();
    let calls = 0;
    const value = await context.dlRunWithVisibilityGuard(async () => { calls++; return 'ok'; });
    check('守卫：前台立即执行并返回结果', [value, calls], ['ok', 1]);
    check('守卫：成功后不留监听器', documentStub.listenerCount(), 0);
}

/* ---------- 3. 被中止后等回到前台再重试 ---------- */
{
    const { context, documentStub } = await makeContext();
    const { dlRunWithVisibilityGuard } = context;
    let calls = 0;
    const logs = [];

    const promise = dlRunWithVisibilityGuard(async () => {
        calls++;
        if (calls === 1) {
            // 模拟切后台：中止 + 页面变隐藏
            documentStub.hidden = true;
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            throw err;
        }
        return 'resumed';
    }, (text, kind) => logs.push(kind + ':' + text));

    // 回到前台
    await new Promise((r) => setTimeout(r, 10));
    documentStub.setHidden(false);

    const value = await promise;
    check('守卫：中止后重试并成功', [value, calls], ['resumed', 2]);
    check('守卫：暂停与恢复都有日志',
        [logs.some((l) => l.includes('已暂停')), logs.some((l) => l.includes('回到前台'))],
        [true, true]);
    check('守卫：结束后清理监听器', documentStub.listenerCount(), 0);
}

/* ---------- 4. 真正的错误必须原样抛出，不能重试 ---------- */
{
    const { context } = await makeContext();
    let calls = 0;
    let thrown = null;
    try {
        await context.dlRunWithVisibilityGuard(async () => {
            calls++;
            throw new Error('HTTP 404');
        });
    } catch (e) { thrown = e.message; }
    check('守卫：真错误只执行一次并抛出', [thrown, calls], ['HTTP 404', 1]);
}

/* ---------- 5. 页面已经是隐藏状态时，先等可见再开始 ---------- */
{
    const { context, documentStub } = await makeContext();
    documentStub.hidden = true;
    let executed = false;
    const promise = context.dlRunWithVisibilityGuard(async () => { executed = true; return 'x'; });
    await new Promise((r) => setTimeout(r, 10));
    const beforeVisible = executed;
    documentStub.setHidden(false);
    const value = await promise;
    check('守卫：隐藏时不开始，可见后才执行',
        [beforeVisible, executed, value], [false, true, 'x']);
}

const failed = results.filter((r) => !r.ok);
console.log('\n结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
process.exit(failed.length ? 1 : 0);
