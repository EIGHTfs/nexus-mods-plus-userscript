// ==UserScript==
// @name         Nexus Mods 增强
// @name:en      Nexus Mods Enhancer
// @namespace    nexusmods-enhancer
// @version      1.6.1
// @description  Nexus Mods 中文增强：每页 80 条 + 无限滚动、9 种排序、简中/繁中/翻译与下载量·点赞·体积筛选、中文游戏名一键直达；界面中文化与模组语言徽章；模组页 AI 翻译/结构化分析 + 文件直链下载，下载时自动按 mod 名建文件夹（可选保存目录，安装包与预览图归档进同一目录，图片也可单独下，支持断点续传；脚本设置面板集中管理下载/界面/AI），合集批量下载（进度·暂停·断点），下载历史自动标出有更新的模组。
// @description:en  A Chinese-first Nexus Mods enhancer: 80 items per page with infinite scroll, 9 sort modes, Chinese/language plus downloads·endorsements·size filters, Chinese game-name lookup, localized UI and language badges; AI translation and structured analysis with direct file downloads on mod pages, downloads auto-filed into a per-mod folder under a chosen directory (archive plus preview images, images downloadable separately, resumable, with a unified settings panel), collection batch download with progress/pause/resume, and update highlighting in download history.
// @icon         data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'><rect x='3' y='3' width='122' height='122' rx='26' fill='%2316161B' stroke='%23302F38' stroke-width='2'/><rect x='26' y='32' width='15' height='64' rx='2' fill='%23F5F3EE'/><rect x='73' y='32' width='15' height='64' rx='2' fill='%23F5F3EE'/><path d='M40 32h15L73 96H58z' fill='%23DA8E35'/><path d='M102 12l3 9 9 3-9 3-3 9-3-9-9-3 9-3z' fill='%23D34A4A'/></svg>
// @author       SmallRob
// @match        https://www.nexusmods.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_deleteValue
// @grant        GM_download
// @grant        unsafeWindow
// @connect      staticdelivery.nexusmods.com
// @connect      api.nexusmods.com
// @connect      store.steampowered.com
// @connect      api.deepseek.com
// @connect      api.openai.com
// @connect      *
// @run-at       document-start
// @license      MIT
// @tag          NexusMods
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '1.6.1';
    const API = 'https://api.nexusmods.com/v2/graphql';
    const LOG_PREFIX = '[N网增强]';
    const AI_DEFAULT_URL = 'https://api.deepseek.com/v1/chat/completions';
    const AI_DEFAULT_MODEL = 'deepseek-chat';
    const AI_MAX_DESC = 12000;      // 送给 AI 的描述正文上限（字符）
    const AI_TIMEOUT = 120000;

    // ==================== 配置 ====================

    const DEFAULTS = {
        pageSize: 80,      // 每页条数：20 / 40 / 60 / 80（服务端硬上限 80）
        view: 'enhanced',  // enhanced | native
        zhUI: true,        // 界面中文化
        badges: true,      // 模组语言徽章
        sortBy: 'createdAt',
        sortDir: 'DESC',
        minDownloads: 0,   // 下载量下限
        minEndorsements: 0,// 点赞数下限
        maxSizeMB: 0,      // 文件大小上限（MB）
        keyword: '',       // 关键词
        chips: { zh: false, zht: false, tr: false, hot: false }, // 快捷筛选状态
        skipWait: true,    // 下载等待页自动跳过
        dlGap: 5,          // 合集批量下载间隔（秒）
        dlFolder: true,    // 按 mod 名建文件夹归档（GM_download 子目录）
        // 图片默认不跟着安装包一起下：图库动辄十几张，每次下 mod 都顺带请求一遍
        // 既费流量也拖慢下载队列。改为面板上独立的「下载图片」按钮按需触发。
        dlImagesWithMod: false,
        dlImgLimit: 12     // 单个 mod 最多下载几张图片（0 = 不限）
    };

    let CFG = Object.assign({}, DEFAULTS);
    try {
        const saved = JSON.parse(GM_getValue('nme.cfg', '{}') || '{}');
        if (saved && typeof saved === 'object') Object.assign(CFG, saved);
    } catch (e) { /* 配置损坏则用默认值 */ }

    function saveCfg() {
        try { GM_setValue('nme.cfg', JSON.stringify(CFG)); } catch (e) { /* 忽略 */ }
    }

    const DEBUG = false;
    function dbg(...args) { if (DEBUG) console.log(LOG_PREFIX, ...args); }

    // ==================== 通用工具 ====================

    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    function fmtNum(n) {
        if (n === null || n === undefined) return '—';
        return Number(n).toLocaleString('en-US');
    }

    function fmtSize(bytes) {
        if (!bytes && bytes !== 0) return '—';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let v = Number(bytes), i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return (i === 0 ? v : v.toFixed(1)) + units[i];
    }

    /** 相对时间（中文） */
    function fmtRelative(iso) {
        if (!iso) return '—';
        const t = new Date(iso).getTime();
        if (!isFinite(t)) return '—';
        const diff = Date.now() - t;
        const min = Math.floor(diff / 60000);
        if (min < 1) return '刚刚';
        if (min < 60) return min + ' 分钟前';
        const hr = Math.floor(min / 60);
        if (hr < 24) return hr + ' 小时前';
        const day = Math.floor(hr / 24);
        if (day < 30) return day + ' 天前';
        const mo = Math.floor(day / 30);
        if (mo < 12) return mo + ' 个月前';
        return Math.floor(mo / 12) + ' 年前';
    }

    /** 日期（中文） */
    function fmtDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        if (isFinite(d.getTime())) return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
        return '—';
    }

    function debounce(fn, ms) {
        let t = null;
        return function () {
            const args = arguments, self = this;
            clearTimeout(t);
            t = setTimeout(() => fn.apply(self, args), ms);
        };
    }

    // ==================== 中文字典 ====================
    // 只做「整段文本完全匹配」的替换，避免误伤句子内部单词。

    const ZH = {
        'Show filters': '显示筛选',
        'Hide filters': '隐藏筛选',
        'Filter': '筛选',
        'Sort': '排序',
        'All time': '全部时间',
        'Date Published': '发布日期',
        'Desc': '降序',
        'Asc': '升序',
        'Endorsements': '点赞数',
        'Downloads': '下载量',
        'Unique Downloads': '独立下载量',
        'Last Updated': '最近更新',
        'Mod Name': '模组名称',
        'File Size': '文件大小',
        'Last Comment': '最近评论',
        'Surprise': '随机惊喜',
        'Category': '分类',
        'Tags': '标签',
        'Search parameters': '搜索参数',
        'Title': '标题',
        'Description': '描述',
        'Author': '作者',
        'Uploader': '上传者',
        'Includes': '包含',
        'Excludes': '排除',
        'Apply': '应用',
        'Show Tags': '显示标签',
        'Language support': '语言支持',
        'Content options': '内容选项',
        'File size': '文件大小',
        'No min': '最小值',
        'No max': '最大值',
        'Mod options': '模组选项',
        'Previous page': '上一页',
        'Next page': '下一页',
        'Go': '跳转',
        'Log in': '登录',
        'Sign up': '注册',
        'Download App': '下载客户端',
        'Search': '搜索',
        'Files': '文件',
        'Images': '图片',
        'Videos': '视频',
        'Posts': '帖子',
        'Bugs': '问题',
        'Logs': '日志',
        'Stats': '统计',
        'My mods': '我的模组',
        'My media': '我的媒体',
        'My collections': '我的合集',
        'News': '新闻',
        'Support': '支持',
        'Community': '社区',
        'Media': '媒体',
        'Collections': '合集',
        'Games': '游戏',
        'Mods': '模组',
        'Account': '账户',
        'Messages': '消息',
        'Notifications': '通知',
        'Premium': '高级会员',
        'Get more': '获取更多',
        'Learn more': '了解更多',
        'Edit': '编辑',
        'Remove': '移除',
        'Download': '下载',
        'Install': '安装',
        'Update': '更新',
        'Loading': '加载中',
        'Error': '错误',
        'Retry': '重试',
        'Close': '关闭',
        'Cancel': '取消',
        'Save': '保存',
        'Done': '完成',
        'Enabled': '启用',
        'Disabled': '禁用',
        'Followers': '关注者',
        'Posts ': '帖子 ',
        // —— 站点公共区域 ——
        'Page': '页',
        'to': '至',
        'Home': '首页',
        'Clear game filter': '清除游戏筛选',
        'Skip to content': '跳到正文',
        "Browse the internet's best mods": '浏览全网最好的模组',
        'Premium features': '高级功能',
        'Mod faster with premium': '开通高级会员，下载更快',
        'Discover': '发现',
        'All games': '所有游戏',
        'All mods': '所有模组',
        'New mods': '最新模组',
        'Popular mods': '热门模组',
        'Trending mods': '趋势模组',
        'All collections': '所有合集',
        'All images': '所有图片',
        'Help': '帮助',
        'Wiki': 'Wiki',
        'API': 'API',
        'Feedback': '反馈',
        'Report a bug': '报告缺陷',
        'Unban requests': '解封申请',
        'DMCA': 'DMCA',
        'Forums': '论坛',
        'Discord': 'Discord',
        'Support authors': '支持作者',
        'Contact us': '联系我们',
        'Manage cookie settings': '管理 Cookie 设置',
        'News': '新闻',
        'Statistics': '统计',
        'Careers': '加入我们',
        'About us': '关于我们',
        'Terms of Service': '服务条款',
        'Privacy Policy': '隐私政策',
        'Members': '会员',
        'Kudos': 'Kudos 积分',
        'Server info': '服务器信息',
        'Network stats': '网络状态',
        'Make mods. Earn rewards.': '创作模组，赚取奖励。',
        'Learn More': '了解更多',
        // —— 筛选面板 ——
        'Hide translations': '隐藏翻译',
        'Hide adult content': '隐藏成人内容',
        'Show only adult content': '仅显示成人内容',
        'Supported by Vortex': '支持 Vortex',
        'Show only updated mods': '仅显示有更新的模组',
        'Minimum': '最小值',
        'Maximum': '最大值',
        // —— 模组详情页 ——
        'Requirements': '依赖',
        'Conflicts': '冲突',
        'Installation': '安装',
        'Manual': '手动',
        'Automatic': '自动',
        'Mod ID': '模组 ID',
        'File ID': '文件 ID',
        'Created': '创建于',
        'Updated': '更新于',
        'Size': '大小',
        'Type': '类型',
        'Version': '版本',
        'Game version': '游戏版本',
        'Preview': '预览',
        'Report': '举报',
        'Comments': '评论',
        'Leave a comment': '发表评论',
        'Moderator': '管理员',
        'Views': '浏览量',
        'Replies': '回复',
        // —— 搜索参数占位符 ——
        'Title contains': '标题包含',
        'Description contains': '描述包含',
        'Author contains': '作者包含',
        'Uploader contains': '上传者包含',
        // —— 模组分类（Nexus 全站统一分类表）——
        'Alchemy': '炼金',
        'Animation': '动画',
        'Armour': '护甲',
        'Armour - Shields': '护甲 - 盾牌',
        'Audio': '音频',
        'Body, Face, and Hair': '身体、面部与发型',
        'Bug Fixes': '缺陷修复',
        'Buildings': '建筑',
        'Cheats and God items': '作弊与神器',
        'Cities, Towns, Villages, and Hamlets': '城镇与村庄',
        'Clothing and Accessories': '服装与配饰',
        'Collectables, Treasure Hunts, and Puzzles': '收藏品、寻宝与解谜',
        'Combat': '战斗',
        'Crafting': '制作',
        'Creatures and Mounts': '生物与坐骑',
        'Dungeons': '地下城',
        'Environmental': '环境',
        'Followers & Companions': '随从与同伴',
        'Followers & Companions - Creatures': '随从与同伴 - 生物',
        'Gameplay': '玩法',
        'Guilds/Factions': '公会/阵营',
        'Immersion': '沉浸',
        'Items and Objects - Player': '物品与物件 - 玩家',
        'Items and Objects - World': '物品与物件 - 世界',
        'Locations - New': '地点 - 新增',
        'Locations - Vanilla': '地点 - 原版',
        'Magic - Gameplay': '魔法 - 玩法',
        'Magic - Spells & Enchantments': '魔法 - 法术与附魔',
        'Miscellaneous': '杂项',
        'Modders Resources': '创作者资源',
        'Models and Textures': '模型与材质',
        'NPC': 'NPC',
        'Overhauls': '全面重制',
        'Patches': '补丁',
        'Player homes': '玩家住宅',
        'Presets - ENB and ReShade': '预设 - ENB 与 ReShade',
        'Quests and Adventures': '任务与冒险',
        'Races, Classes, and Birthsigns': '种族、职业与命星',
        'Save Games': '存档',
        'Shouts': '吼叫',
        'Skills and Leveling': '技能与升级',
        'Stealth': '潜行',
        'User Interface': '用户界面',
        'Utilities': '工具',
        'Visuals and Graphics': '视觉与画面',
        'VR': 'VR',
        'Weapons': '武器',
        'Weapons and Armour': '武器与护甲',
        // —— 语言（筛选面板 / 标签）——
        'Simplified Chinese': '简体中文',
        'Traditional Chinese': '繁体中文',
        'English': '英语',
        'German': '德语',
        'French': '法语',
        'Spanish': '西班牙语',
        'Russian': '俄语',
        'Japanese': '日语',
        'Korean': '韩语',
        'Polish': '波兰语',
        'Portuguese': '葡萄牙语',
        'Italian': '意大利语',
        'Turkish': '土耳其语',
        'Czech': '捷克语',
        'Hungarian': '匈牙利语',
        'Ukrainian': '乌克兰语',
        'Dutch': '荷兰语',
        'Arabic': '阿拉伯语',
        'Vietnamese': '越南语',
        'Indonesian': '印尼语',
        'Afrikaans': '南非荷兰语',
        'Chinese': '中文'
    };

    const RE_RESULTS = /^([\d,]+)\s+results$/;
    const RE_ITEMS = /^(\d+)\s+Items$/;
    // 「名称 (1,234)」形式：分类 / 语言 / 标签的计数行
    const RE_COUNTED = /^([^()]+?)\s*\(\s*[\d,]+\s*\)$/;

    // ==================== React 水合（hydration）兼容 ====================
    // Nexus 是 Next.js（React 19）站点，服务端渲染出英文文本，客户端再水合。
    // 如果在水合完成前改写文本节点，React 会判定「服务端文本与客户端不一致」，
    // 抛出 Minified React error #418，并把整棵树改成客户端重新渲染 ——
    // 结果就是我们的中文被 React 冲掉，同时控制台报错。
    //
    // 判定方式：React 水合过的宿主元素上会挂 __reactFiber$ / __reactProps$ 标记。
    // 只有「父元素已被 React 接管」的文本才允许改写，其余留给后续扫描。

    const REACT_FIBER = '__reactFiber$';
    const REACT_PROPS = '__reactProps$';

    /** 元素是否已被 React 接管（已水合或已渲染） */
    function isReactManaged(el) {
        if (!el) return false;
        try {
            for (const k in el) {
                if (k.indexOf(REACT_FIBER) === 0 || k.indexOf(REACT_PROPS) === 0) return true;
            }
        } catch (e) { /* 忽略：个别元素可能抛错 */ }
        return false;
    }

    /** 文本节点所在位置是否已被 React 接管 */
    function isTextNodeHydrated(node) {
        const p = node && node.parentElement;
        if (!p) return false;
        if (isReactManaged(p)) return true;
        // 向上再找一层：React 可能把文本挂在更外层的宿主元素上
        const up = p.parentElement;
        return !!(up && isReactManaged(up));
    }

    /** 页面里是否存在 React 接管过的元素（用来判断站点是否走 React 水合） */
    function pageHasReact() {
        if (state.reactSeen) return true;
        const probes = ['#__next', '#root', 'main', 'body > div'];
        for (let i = 0; i < probes.length; i++) {
            const el = $(probes[i]);
            if (el && isReactManaged(el)) { state.reactSeen = true; return true; }
        }
        return false;
    }

    /**
     * 站点是否为 React / Next.js 应用。
     * 只看首屏 HTML 里就存在的标记（__NEXT_DATA__ / #__next 等），
     * 这些在 init() 执行时（DOMContentLoaded）一定已经解析完。
     */
    function detectReactApp() {
        try {
            if (typeof window.__NEXT_DATA__ !== 'undefined') return true;
            if (window.__next_f || (window.next && window.next.version)) return true;
            if (document.querySelector('#__next, #root, [data-reactroot]')) return true;
        } catch (e) { /* 忽略 */ }
        return false;
    }

    /** React 接管并水合的根容器（上面挂 __reactContainer$ 标记） */
    function findReactContainer() {
        if (state.reactContainer !== null) return state.reactContainer;
        const cands = ['#__next', '#root', 'body', 'main'];
        for (let i = 0; i < cands.length; i++) {
            const el = $(cands[i]);
            if (!el) continue;
            for (const k in el) {
                if (k.indexOf('__reactContainer$') === 0) { state.reactContainer = el; return el; }
            }
        }
        return null;
    }

    /**
     * 水合是否已经开始提交。
     * React 提交时会给宿主元素挂 __reactFiber$ / __reactProps$；
     * 提交前一个标记都没有，此时改写文本必然触发 #418。
     */
    function reactHydrated() {
        if (state.reactContainer === null) findReactContainer();
        const container = state.reactContainer;
        if (container) {
            const kids = container.querySelectorAll('*');
            const n = Math.min(kids.length, 60);
            for (let j = 0; j < n; j++) {
                if (isReactManaged(kids[j])) { state.hydrated = true; return true; }
            }
            if (kids.length) return false;
        }
        // 没有容器标记时，退回到通用探测
        const roots = ['main', 'body'];
        for (let i = 0; i < roots.length; i++) {
            const root = $(roots[i]);
            if (!root) continue;
            const kids = root.querySelectorAll('*');
            const n = Math.min(kids.length, 60);
            for (let j = 0; j < n; j++) {
                if (isReactManaged(kids[j])) { state.hydrated = true; return true; }
            }
            if (kids.length) return false;
        }
        return false;
    }

    /**
     * 这个文本节点现在能不能改？
     *
     * React 水合时会逐个比对服务端文本与客户端文本；只要在水合提交前
     * 改动了任何一处文本，React 就报 #418 并把整棵树改成客户端重渲染
     * （我们的中文随之被冲掉）。
     *
     * 判定顺序：
     *  1. 非 React 站点 → 随便改；
     *  2. React 站点但还没提交 → 一律不改；
     *  3. 父元素已被 React 接管 → 该处文本比对已完成，可以改；
     *  4. 在 React 容器之外 → 与 React 无关，可以改；
     *  5. 在容器内但父元素还没被接管 → 可能仍在水合（Suspense 分块提交），先跳过。
     */
    function canTranslateNode(node) {
        if (!state.reactApp) return true;
        if (!state.hydrated) return false;
        const p = node.parentElement;
        if (!p) return false;
        if (isReactManaged(p)) return true;
        const container = state.reactContainer || findReactContainer();
        if (container && !container.contains(p)) return true;
        return false;
    }

    // 脚本自己插入的界面不参与中文化，避免词表误伤（例如状态文案里的英文单词）
    const OWN_UI_SEL = '#nme-panel,#nme-ai-bar,#nme-dl-bar,#nme-toast,#nme-hist-bar,#nme-ai-cfg-modal,#nme-dock';

    function translateTree(root) {
        if (!root) return;
        const skipTags = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, OPTION: 1, SELECT: 1, NOSCRIPT: 1 };
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                const p = node.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                if (skipTags[p.tagName]) return NodeFilter.FILTER_REJECT;
                if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
                if (p.closest(OWN_UI_SEL)) return NodeFilter.FILTER_REJECT;
                // React 水合中的文本不能动：改写会触发 React #418 并被 React 冲掉
                if (!canTranslateNode(node)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);

        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            const raw = n.nodeValue;
            const trimmed = raw.trim();
            if (!trimmed) continue;
            if (Object.prototype.hasOwnProperty.call(ZH, trimmed)) {
                n.nodeValue = raw.replace(trimmed, ZH[trimmed]);
                continue;
            }
            let m = RE_RESULTS.exec(trimmed);
            if (m) { n.nodeValue = raw.replace(trimmed, '共 ' + m[1] + ' 条结果'); continue; }
            m = RE_ITEMS.exec(trimmed);
            if (m) { n.nodeValue = raw.replace(trimmed, m[1] + ' 条'); continue; }
            m = RE_COUNTED.exec(trimmed);
            if (m) {
                const base = m[1].trim();
                if (Object.prototype.hasOwnProperty.call(ZH, base)) {
                    n.nodeValue = raw.replace(base, ZH[base]);
                }
            }
        }

        const attrs = ['aria-label', 'title', 'placeholder'];
        const els = root.querySelectorAll ? root.querySelectorAll('[aria-label],[title],[placeholder]') : [];
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            if (el.isContentEditable || el.closest(OWN_UI_SEL)) continue;
            for (let j = 0; j < attrs.length; j++) {
                const v = el.getAttribute(attrs[j]);
                if (v && Object.prototype.hasOwnProperty.call(ZH, v)) el.setAttribute(attrs[j], ZH[v]);
            }
        }
    }

    // ==================== 语言徽章 ====================

    const SUFFIX_HANS = /[-_](CHS|CH|简中|简体中文|CN|中文)\s*(?:v?\d[\d.]*)?\s*$/i;
    const SUFFIX_HANT = /[-_](CHT|繁中|繁体中文|TC)\s*(?:v?\d[\d.]*)?\s*$/i;

    /**
     * 从模组名后缀 + 作者打的标签推断语言徽章。
     * 注意：Nexus 的语言标签只有「Chinese」而没有区分简/繁，
     * 因此带标签时只能给「中文」，简繁区分仅靠名称后缀（社区惯例 -CHS / -CHT）。
     */
    function detectBadges(mod) {
        const badges = [];
        const name = mod.name || '';
        const tags = (mod.tags || []).map(t => t.name);

        if (SUFFIX_HANT.test(name)) badges.push({ cls: 'nme-badge-hant', text: '繁中' });
        else if (SUFFIX_HANS.test(name)) badges.push({ cls: 'nme-badge-hans', text: '简中' });
        else if (tags.indexOf('Chinese') >= 0) badges.push({ cls: 'nme-badge-zh', text: '中文' });

        if (tags.indexOf('Translation') >= 0) badges.push({ cls: 'nme-badge-tr', text: '翻译' });
        if (mod.directDownloadEnabled === true) badges.push({ cls: 'nme-badge-direct', text: '直链' });
        return badges;
    }

    // ==================== GraphQL 客户端 ====================

    const Q_MODS = `query ModsListing($count: Int = 0, $facets: ModsFacet, $filter: ModsFilter, $offset: Int, $postFilter: ModsFilter, $sort: [ModsSort!]) {
  mods(count: $count, facets: $facets, filter: $filter, offset: $offset, postFilter: $postFilter, sort: $sort, viewUserBlockedContent: false) {
    facetsData
    nodes {
      modId
      name
      summary
      downloads
      endorsements
      fileSize
      createdAt
      updatedAt
      thumbnailUrl
      game { domainName name }
      modCategory { categoryId name }
      uploader { name memberId avatar }
      tags { name }
      directDownloadEnabled
    }
    totalCount
  }
}`;

    async function queryMods(variables) {
        const res = await fetch(API, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-graphql-operationname': 'ModsListing'
            },
            credentials: 'include',
            body: JSON.stringify({ query: Q_MODS, variables: variables, operationName: 'ModsListing' })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json.errors && json.errors.length) {
            throw new Error(json.errors[0].message || 'GraphQL error');
        }
        return json.data.mods;
    }

    // ==================== AI 配置与通用请求 ====================

    const aiCfg = {
        url: AI_DEFAULT_URL,
        key: '',
        model: AI_DEFAULT_MODEL
    };
    try {
        const savedAi = JSON.parse(GM_getValue('nme.ai', '{}') || '{}');
        if (savedAi && typeof savedAi === 'object') Object.assign(aiCfg, savedAi);
    } catch (e) { /* 忽略 */ }

    function saveAiCfg() {
        try { GM_setValue('nme.ai', JSON.stringify(aiCfg)); } catch (e) { /* 忽略 */ }
    }

    function aiConfigured() { return !!(aiCfg.key && aiCfg.url && aiCfg.model); }

    /**
     * 通用 HTTP 请求：优先 GM_xmlhttpRequest（可跨域、可读 Steam 页面），
     * 缺失时回退 fetch。返回 { status, text }。
     */
    function request(opts) {
        const method = opts.method || 'GET';
        const timeout = opts.timeout || 30000;
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise(function (resolve, reject) {
                GM_xmlhttpRequest({
                    method: method,
                    url: opts.url,
                    headers: opts.headers || {},
                    data: opts.body,
                    timeout: timeout,
                    onload: function (r) { resolve({ status: r.status, text: r.responseText || '' }); },
                    onerror: function () { reject(new Error('网络请求失败')); },
                    ontimeout: function () { reject(new Error('请求超时')); }
                });
            });
        }
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout);
        return fetch(opts.url, {
            method: method,
            headers: opts.headers || {},
            body: opts.body,
            signal: ctrl ? ctrl.signal : undefined
        }).then(function (r) {
            clearTimeout(timer);
            return r.text().then(function (t) { return { status: r.status, text: t }; });
        }, function (e) { clearTimeout(timer); throw e; });
    }

    /** 调用 OpenAI / DeepSeek 兼容接口，返回纯文本内容 */
    async function callAi(prompt, opts) {
        opts = opts || {};
        // 允许临时传入配置（用于「测试」按钮），避免改写全局 aiCfg 与进行中的请求打架
        const cfg = Object.assign({}, aiCfg, opts.cfg || {});
        if (!cfg.key || !cfg.url || !cfg.model) throw new Error('未配置 AI 接口，请点「AI 配置」填写');
        let res;
        try {
            res = await request({
                method: 'POST',
                url: cfg.url,
                timeout: opts.timeout || AI_TIMEOUT,
                headers: {
                    'content-type': 'application/json',
                    'authorization': 'Bearer ' + cfg.key
                },
                body: JSON.stringify({
                    model: cfg.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: opts.temperature != null ? opts.temperature : 0.3,
                    max_tokens: opts.maxTokens || 4096
                })
            });
        } catch (e) {
            throw new Error('AI 请求失败：' + (e && e.message || e));
        }
        if (res.status < 200 || res.status >= 300) {
            let detail = '';
            try {
                const j = JSON.parse(res.text);
                detail = (j.error && (j.error.message || j.error)) || j.message || '';
                if (typeof detail === 'object') detail = JSON.stringify(detail);
            } catch (e) { detail = (res.text || '').slice(0, 160); }
            throw new Error('AI HTTP ' + res.status + (detail ? '：' + detail : ''));
        }
        let json;
        try { json = JSON.parse(res.text); } catch (e) { throw new Error('AI 返回不是合法 JSON'); }
        const choice = (json.choices && json.choices[0]) || {};
        const content = (choice.message && choice.message.content) || '';
        if (!content) throw new Error('AI 返回内容为空');
        return content;
    }

    /** 从 AI 文本里提取第一个 JSON 对象 */
    function parseAiJson(text) {
        if (!text) throw new Error('AI 返回为空');
        let s = String(text).replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, '').trim();
        s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        const start = s.indexOf('{');
        if (start < 0) throw new Error('AI 返回中找不到 JSON');
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < s.length; i++) {
            const ch = s[i];
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    return JSON.parse(s.slice(start, i + 1));
                }
            }
        }
        throw new Error('AI 返回 JSON 未闭合（可能被截断）');
    }

    // —— 本地缓存：AI 结果（40 条）与中文找游戏（30 条）分开配额，互不挤占 ——

    function cacheGet(prefix, key) {
        try {
            const raw = GM_getValue(prefix + key, '');
            if (!raw) return null;
            const rec = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!rec || !rec.v) return null;
            return rec;
        } catch (e) { return null; }
    }

    function cacheSet(prefix, idxKey, key, value, limit) {
        try {
            GM_setValue(prefix + key, JSON.stringify({ t: Date.now(), v: value }));
            let idx = [];
            try { idx = JSON.parse(GM_getValue(idxKey, '[]') || '[]'); } catch (e) { idx = []; }
            idx = idx.filter(function (k) { return k !== key; });
            idx.push(key);
            while (idx.length > limit) {
                const drop = idx.shift();
                try { GM_deleteValue(prefix + drop); } catch (e) { GM_setValue(prefix + drop, ''); }
            }
            GM_setValue(idxKey, JSON.stringify(idx));
        } catch (e) { /* 忽略缓存失败 */ }
    }

    function aiCacheGet(key) { return cacheGet('nme.ai.', key); }
    function aiCacheSet(key, value) { cacheSet('nme.ai.', 'nme.ai.idx', key, value, 40); }
    function gameCacheGet(key) { return cacheGet('nme.gc.', key); }
    function gameCacheSet(key, value) { cacheSet('nme.gc.', 'nme.gc.idx', key, value, 30); }


    // ==================== 中文游戏名 → Nexus 游戏 ====================
    //
    // 背景：Nexus 的游戏名/域名只有英文，中文关键词在它的搜索里必然 0 结果。
    // 链路：中文输入 →（本地常见别名表）→（Steam 国区搜索拿 appid）→ appdetails 取英文名
    //       → Nexus games(WILDCARD) → 游戏域名 → /games/<domain>/mods
    //
    // 说明：SGLV 的「中英文别名」是 appid → 中文名（小黑盒），方向相反且必须先有 appid，
    // 不能直接回答「中文→英文」；这里改用 Steam 国区搜索作为 appid 解析器，本地别名表兜底。

    const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

    /** 常见模组游戏的中文叫法。domain 均已在 Nexus 实测存在（2026-11-04）。 */
    const ZH_GAME_ALIASES = [
        { cn: ['上古卷轴5', '上古卷轴5天际', '老滚5', 'skyrim'], items: [{ name: 'Skyrim Special Edition', domain: 'skyrimspecialedition' }, { name: 'Skyrim', domain: 'skyrim' }] },
        { cn: ['辐射4', '异尘余生4', 'fallout4'], items: [{ name: 'Fallout 4', domain: 'fallout4' }] },
        { cn: ['赛博朋克2077', '赛博朋克', 'cyberpunk'], items: [{ name: 'Cyberpunk 2077', domain: 'cyberpunk2077' }] },
        { cn: ['艾尔登法环', '老头环', 'elden ring'], items: [{ name: 'Elden Ring', domain: 'eldenring' }] },
        { cn: ['博德之门3', '博德3', 'bg3'], items: [{ name: "Baldur's Gate 3", domain: 'baldursgate3' }] },
        { cn: ['巫师3', '巫师三', 'witcher3'], items: [{ name: 'The Witcher 3: Wild Hunt', domain: 'witcher3' }] },
        { cn: ['剑星', 'stellar blade'], items: [{ name: 'Stellar Blade', domain: 'stellarblade' }] },
        { cn: ['影之刃零', 'phantom blade zero', '影之刃'], items: [{ name: 'Phantom Blade Zero', domain: 'phantombladezero' }] },
        { cn: ['黑神话悟空', '黑神话', 'wukong'], items: [{ name: 'Black Myth: Wukong', domain: 'blackmythwukong' }] },
        { cn: ['怪物猎人荒野', '怪物猎人：荒野'], items: [{ name: 'Monster Hunter Wilds', domain: 'monsterhunterwilds' }] },
        { cn: ['怪物猎人世界', '怪物猎人：世界'], items: [{ name: 'Monster Hunter: World', domain: 'monsterhunterworld' }] },
        { cn: ['怪物猎人崛起', '怪物猎人：崛起'], items: [{ name: 'Monster Hunter Rise', domain: 'monsterhunterrise' }] },
        { cn: ['只狼'], items: [{ name: 'Sekiro: Shadows Die Twice', domain: 'sekiro' }] },
        { cn: ['最终幻想7重制版', '最终幻想7remake', 'ff7重制版'], items: [{ name: 'Final Fantasy VII Remake', domain: 'finalfantasy7remake' }] },
        { cn: ['最终幻想7重生', 'ff7重生'], items: [{ name: 'Final Fantasy VII Rebirth', domain: 'finalfantasy7rebirth' }] },
        { cn: ['星空', 'starfield'], items: [{ name: 'Starfield', domain: 'starfield' }] },
        { cn: ['霍格沃茨之遗', '霍格沃茨'], items: [{ name: 'Hogwarts Legacy', domain: 'hogwartslegacy' }] },
        { cn: ['龙之信条2'], items: [{ name: "Dragon's Dogma 2", domain: 'dragonsdogma2' }] },
        { cn: ['尼尔机械纪元', '尼尔自动人形'], items: [{ name: 'NieR: Automata', domain: 'nierautomata' }] },
        { cn: ['女神异闻录5', 'p5r'], items: [{ name: 'Persona 5 Royal', domain: 'persona5royal' }] },
        { cn: ['天国拯救2', '天国：拯救2'], items: [{ name: 'Kingdom Come: Deliverance II', domain: 'kingdomcomedeliverance2' }] },
        { cn: ['幻兽帕鲁', '帕鲁'], items: [{ name: 'Palworld', domain: 'palworld' }] },
        { cn: ['侠盗猎车手5', 'gta5', 'gta v'], items: [{ name: 'Grand Theft Auto V', domain: 'gta5' }] },
        { cn: ['荒野大镖客2', '大表哥2', 'rdr2'], items: [{ name: 'Red Dead Redemption 2', domain: 'reddeadredemption2' }] },
        { cn: ['泰拉瑞亚'], items: [{ name: 'Terraria', domain: 'terraria' }] },
        { cn: ['星露谷物语'], items: [{ name: 'Stardew Valley', domain: 'stardewvalley' }] },
        { cn: ['英灵神殿'], items: [{ name: 'Valheim', domain: 'valheim' }] },
        { cn: ['环世界', 'rimworld'], items: [{ name: 'Rimworld', domain: 'rimworld' }] },
        { cn: ['城市天际线2'], items: [{ name: 'Cities: Skylines II', domain: 'citiesskylines2' }] },
        { cn: ['模拟人生4'], items: [{ name: 'The Sims 4', domain: 'thesims4' }] },
        { cn: ['刺客信条起源'], items: [{ name: "Assassin's Creed Origins", domain: 'assassinscreedorigins' }] },
        { cn: ['战神5', '战神诸神黄昏'], items: [{ name: 'God of War Ragnarok', domain: 'godofwarragnarok' }] },
        { cn: ['战神4', '战神'], items: [{ name: 'God of War', domain: 'godofwar' }] },
        { cn: ['漫威蜘蛛侠2', '蜘蛛侠2'], items: [{ name: "Marvel's Spider-Man 2", domain: 'marvelsspiderman2' }] },
        { cn: ['地平线零之曙光'], items: [{ name: 'Horizon Zero Dawn', domain: 'horizonzerodawn' }] },
        { cn: ['死亡搁浅'], items: [{ name: 'Death Stranding', domain: 'deathstranding' }] },
        { cn: ['匹诺曹的谎言'], items: [{ name: 'Lies of P', domain: 'liesofp' }] },
        { cn: ['黑暗之魂3', '黑魂3'], items: [{ name: 'Dark Souls 3', domain: 'darksouls3' }] },
        { cn: ['黑暗之魂重制版', '黑魂1'], items: [{ name: 'Dark Souls Remastered', domain: 'darksoulsremastered' }] },
        { cn: ['幽浮2', 'xcom2'], items: [{ name: 'XCOM 2', domain: 'xcom2' }] },
        { cn: ['暗黑破坏神2重制版', '暗黑2重制版'], items: [{ name: 'Diablo II: Resurrected', domain: 'diablo2resurrected' }] },
        { cn: ['龙珠电光炸裂zero', '电光炸裂'], items: [{ name: 'Dragon Ball: Sparking ZERO', domain: 'dragonballsparkingzero' }] },
        { cn: ['铁拳8'], items: [{ name: 'Tekken 8', domain: 'tekken8' }] },
        { cn: ['街霸6', '街头霸王6'], items: [{ name: 'Street Fighter 6', domain: 'streetfighter6' }] },
        { cn: ['剑与魔法', 'blade and sorcery'], items: [{ name: 'Blade & Sorcery', domain: 'bladeandsorcery' }] },
        { cn: ['僵尸毁灭工程'], items: [{ name: 'Project Zomboid', domain: 'projectzomboid' }] },
        { cn: ['七日杀'], items: [{ name: '7 Days To Die', domain: '7daystodie' }] },
        { cn: ['孤岛惊魂6'], items: [{ name: 'Far Cry 6', domain: 'farcry6' }] },
        { cn: ['消逝的光芒2'], items: [{ name: 'Dying Light 2', domain: 'dyinglight2' }] },
        { cn: ['死亡岛2'], items: [{ name: 'Dead Island 2', domain: 'deadisland2' }] },
        { cn: ['深海迷航'], items: [{ name: 'Subnautica', domain: 'subnautica' }] },
        { cn: ['空洞骑士'], items: [{ name: 'Hollow Knight', domain: 'hollowknight' }] },
        { cn: ['传说之下'], items: [{ name: 'Undertale', domain: 'undertale' }] },
        { cn: ['亿万僵尸'], items: [{ name: 'They Are Billions', domain: 'theyarebillions' }] },
        { cn: ['幸福工厂'], items: [{ name: 'Satisfactory', domain: 'satisfactory' }] },
        { cn: ['异星工厂'], items: [{ name: 'Factorio', domain: 'factorio' }] },
        { cn: ['矮人要塞'], items: [{ name: 'Dwarf Fortress', domain: 'dwarffortress' }] }
    ];

    function normKey(s) {
        return String(s == null ? '' : s).toLowerCase()
            .replace(/[\s:：,，.。·'’"“”《》()（）\-—_]/g, '');
    }

    /** 本地别名表命中（按中文键长度降序，支持「上古卷轴5天际」这类包含式输入） */
    function matchLocalAliases(term) {
        const key = normKey(term);
        if (!key) return [];
        const hits = [];
        for (let i = 0; i < ZH_GAME_ALIASES.length; i++) {
            const entry = ZH_GAME_ALIASES[i];
            for (let j = 0; j < entry.cn.length; j++) {
                const k = normKey(entry.cn[j]);
                if (!k) continue;
                if (key === k || key.indexOf(k) >= 0 || (key.length >= 2 && k.indexOf(key) >= 0)) {
                    hits.push({ entry: entry, len: k.length });
                    break;
                }
            }
        }
        hits.sort(function (a, b) { return b.len - a.len; });
        const out = [];
        const seen = {};
        for (let i = 0; i < hits.length; i++) {
            const items = hits[i].entry.items || [];
            for (let j = 0; j < items.length; j++) {
                if (seen[items[j].domain]) continue;
                seen[items[j].domain] = 1;
                out.push({ name: items[j].name, domain: items[j].domain, modCount: null, source: '本地别名' });
            }
        }
        return out;
    }

    /** Steam 国区搜索（中文关键词）：返回 [{ appid, cn }] */
    async function steamSearchCn(term) {
        const url = 'https://store.steampowered.com/search/?term=' + encodeURIComponent(term) + '&l=schinese&cc=CN';
        const res = await request({ url: url, timeout: 20000, headers: { 'accept-language': 'zh-CN,zh;q=0.9' } });
        if (res.status !== 200) throw new Error('Steam 搜索 HTTP ' + res.status);
        const rows = [];
        const parts = res.text.split('data-ds-appid="');
        for (let i = 1; i < parts.length && rows.length < 8; i++) {
            const block = parts[i];
            const idm = block.match(/^(\d+)/);
            if (!idm) continue;
            const tm = block.match(/<span class="title">([^<]*)<\/span>/);
            if (!tm) continue;
            rows.push({ appid: idm[1], cn: tm[1] });
        }
        return rows;
    }

    /** Steam appdetails：取英文名 */
    async function steamEnglishName(appid) {
        const url = 'https://store.steampowered.com/api/appdetails?appids=' + appid + '&l=english&filters=basic';
        const res = await request({ url: url, timeout: 20000 });
        if (res.status !== 200) return '';
        let j;
        try { j = JSON.parse(res.text); } catch (e) { return ''; }
        const d = j && j[appid] && j[appid].data;
        return (d && d.name) || '';
    }

    /** 英文名候选：去商标符号 / 去版本后缀，逐级收缩 */
    function gameNameVariants(raw) {
        const base = String(raw || '').replace(/[™®©]/g, '').trim();
        const list = [];
        const add = function (s) {
            s = String(s || '').trim().replace(/\s+/g, ' ');
            if (s && list.indexOf(s) < 0) list.push(s);
        };
        add(base);
        add(base.split(/\s+[-—]\s+/)[0]);
        add(base.split(':')[0]);
        const words = base.split(/\s+/);
        if (words.length > 3) add(words.slice(0, 3).join(' '));
        if (words.length > 2) add(words.slice(0, 2).join(' '));
        return list;
    }

    /** Nexus games 名称模糊查询 */
    async function nexusGamesByName(name) {
        const q = 'query GameSearch($filter: GamesSearchFilter) { games(count: 6, filter: $filter) { nodes { id name domainName modCount } } }';
        const res = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-graphql-operationname': 'GameSearch' },
            credentials: 'include',
            body: JSON.stringify({
                query: q,
                variables: { filter: { name: [{ op: 'WILDCARD', value: name }] } },
                operationName: 'GameSearch'
            })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json.errors && json.errors.length) throw new Error(json.errors[0].message || 'GraphQL error');
        return (json.data && json.data.games && json.data.games.nodes) || [];
    }

    /**
     * 解析用户的输入 → 候选游戏列表。
     * 中文：本地别名优先，再 Steam 国区搜索；英文/域名：直接 Nexus games 模糊查。
     */
    async function resolveGame(term) {
        const raw = String(term || '').trim();
        if (!raw) return [];
        const cacheKey = 'cn.' + normKey(raw);
        const cached = gameCacheGet(cacheKey);
        if (cached && Date.now() - cached.t < 7 * 24 * 3600 * 1000) return cached.v;

        const out = [];
        const seen = {};
        const push = function (g) {
            const d = String(g.domain || g.domainName || '').toLowerCase();
            if (!d || seen[d]) return;
            seen[d] = 1;
            out.push({
                name: g.name || d,
                domain: d,
                modCount: g.modCount == null ? null : g.modCount,
                source: g.source || 'Nexus'
            });
        };

        matchLocalAliases(raw).forEach(push);
        // 本地别名命中就不必再走 Steam/GraphQL（快且稳定）
        if (out.length) {
            gameCacheSet(cacheKey, out);
            return out;
        }

        if (CJK_RE.test(raw)) {
            let rows = [];
            try { rows = await steamSearchCn(raw); } catch (e) { rows = []; }
            for (let i = 0; i < Math.min(rows.length, 3); i++) {
                let en = '';
                try { en = await steamEnglishName(rows[i].appid); } catch (e) { en = ''; }
                if (!en) continue;
                const variants = gameNameVariants(en);
                for (let v = 0; v < variants.length; v++) {
                    let games = [];
                    try { games = await nexusGamesByName(variants[v]); } catch (e) { games = []; }
                    if (games.length) {
                        for (let k = 0; k < games.length && k < 3; k++) {
                            games[k].source = 'Steam→Nexus';
                            push(games[k]);
                        }
                        break;
                    }
                }
            }
        } else {
            let games = [];
            try { games = await nexusGamesByName(raw); } catch (e) { games = []; }
            games.forEach(push);
        }

        if (out.length) gameCacheSet(cacheKey, out);
        return out;
    }

    // ==================== 模组详情：AI 翻译 / 分析 ====================

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const Q_GAME_BY_DOMAIN = `query GameByDomain($domain: String!) { game(domainName: $domain) { id name domainName modCount } }`;
    const Q_MOD_DETAIL = `query ModDetail($modId: ID!, $gameId: ID!) {
  mod(modId: $modId, gameId: $gameId) {
    modId name summary description version author createdAt updatedAt downloads endorsements fileSize pictureUrl
    game { id domainName name }
    modCategory { name }
    tags { name }
  }
}`;

    async function gqlRequest(query, variables, operationName) {
        const res = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-graphql-operationname': operationName },
            credentials: 'include',
            body: JSON.stringify({ query: query, variables: variables, operationName: operationName })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json.errors && json.errors.length) throw new Error(json.errors[0].message || 'GraphQL error');
        return json.data;
    }

    /** 拉取模组详情：先用 domain 换 gameId（mod 查询必须 gameId + modId） */
    async function fetchModDetail(domain, modId) {
        const g = await gqlRequest(Q_GAME_BY_DOMAIN, { domain: domain }, 'GameByDomain');
        const game = g && g.game;
        if (!game) throw new Error('未找到游戏：' + domain);
        const d = await gqlRequest(Q_MOD_DETAIL, { modId: modId, gameId: game.id }, 'ModDetail');
        if (!d || !d.mod) throw new Error('未找到模组 #' + modId);
        return d.mod;
    }

    /** Nexus 描述是 BBCode，转成适合喂给 AI 的纯文本 */
    function bbcodeToText(src) {
        let s = String(src || '');
        s = s.replace(/<br\s*\/?>/gi, '\n');
        s = s.replace(/\[img\][\s\S]*?\[\/img\]/gi, '');
        s = s.replace(/\[img=[^\]]*\][\s\S]*?\[\/img\]/gi, '');
        s = s.replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1');
        s = s.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '$1');
        s = s.replace(/\[\*\]/g, '- ');
        s = s.replace(/\[\/(?:b|i|u|s|size|color|center|left|right|quote|spoiler|code|font|list|indent|caption)\]/gi, '');
        s = s.replace(/\[(?:b|i|u|s|size=[^\]]*|color=[^\]]*|center|left|right|quote|spoiler|code|font=[^\]]*|list(?:=[^\]]*)?|indent|caption)\]/gi, '');
        s = s.replace(/&nbsp;/g, ' ');
        s = s.replace(/&amp;/g, '&');
        s = s.replace(/&#92;/g, '\\');
        s = s.replace(/[ \t]+\n/g, '\n');
        s = s.replace(/\n{3,}/g, '\n\n');
        return s.trim();
    }

    function modMetaLine(mod) {
        const parts = [];
        if (mod.version) parts.push('版本 ' + mod.version);
        if (mod.author) parts.push('作者 ' + mod.author);
        if (mod.modCategory && mod.modCategory.name) parts.push('分类 ' + mod.modCategory.name);
        if (mod.tags && mod.tags.length) parts.push('标签 ' + mod.tags.map(function (t) { return t.name; }).join('、'));
        if (mod.downloads != null) parts.push('下载 ' + fmtNum(mod.downloads));
        if (mod.endorsements != null) parts.push('点赞 ' + fmtNum(mod.endorsements));
        if (mod.fileSize != null) parts.push('大小 ' + fmtSize(mod.fileSize));
        if (mod.updatedAt) parts.push('更新 ' + fmtDate(mod.updatedAt));
        return parts.join(' · ');
    }

    function aiStatus(text, kind) {
        const el = $('#nme-ai-status');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'nme-ai-status' + (kind ? ' nme-ai-status-' + kind : '');
    }

    function aiOutput() {
        const el = $('#nme-ai-out');
        if (el) el.hidden = false;
        return el;
    }

    function aiTextHtml(text) {
        return '<div class="nme-ai-text">' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>';
    }

    // ==================== 浮动按钮坞（AI / 下载）====================
    // 原来 AI 条与下载条直接插在页面内容顶部（main / h1 之后），
    // 正好压在模组头图上，浅色文字叠在风景图上几乎看不清，
    // 也会把首屏版面顶乱。改成右下角一列浮动按钮 + 弹出式浮层：
    // 浮层用不透明底色，文字始终清晰，也不再遮挡页面内容。

    const FAB_SEC_AI = 'ai';
    const FAB_SEC_DL = 'dl';

    /**
     * 右下角统一浮动坞（所有浮动入口的唯一容器）。
     *
     * 之前胶囊（#nme-capsule）和按钮坞（#nme-fab）是两个独立的 fixed 容器，
     * 胶囊收起时面板只是 opacity:0，仍然占着 320x188 的布局空间，
     * 于是这个「透明大盒子」盖在按钮坞上方，把所有点击都吃掉了 ——
     * 表现为「⬇ 下载点了没反应」，实际命中的是 #nme-capsule 而不是按钮。
     *
     * 现在统一到一个 #nme-dock 里：
     *   - 按钮（AI / 下载 / 配置 / 增强视图）竖排在流内，永不重叠；
     *   - 弹出面板绝对定位在坞的上方，且两者互斥（开一个关另一个）；
     *   - 坞本身没有多余尺寸，不会再出现「透明容器挡点击」。
     */
    function ensureDock() {
        let dock = document.getElementById('nme-dock');
        if (dock) return dock;

        dock = document.createElement('div');
        dock.id = 'nme-dock';
        document.body.appendChild(dock);

        // 点击坞以外：同时收起两个弹出面板
        document.addEventListener('click', function (e) {
            if (!dock.contains(e.target)) {
                closeFab();
                closeCapsule();
            }
        });

        return dock;
    }

    /** 收起胶囊快捷面板 */
    function closeCapsule() {
        const dock = document.getElementById('nme-dock');
        if (dock) dock.classList.remove('nme-cap-open');
    }

    function mountFab(ctx) {
        if (!ctx) return null;
        if (ctx.mode !== 'detail' && ctx.mode !== 'collection') return null;

        const dock = ensureDock();

        // 模式变了（合集页 <-> 详情页 SPA 跳转）：先清掉上一套按钮与浮层再重建
        if (dock.getAttribute('data-fab-mode') !== ctx.mode) {
            const oldBtns = $('#nme-fab-btns');
            if (oldBtns) oldBtns.remove();
            const oldCard = $('#nme-fab-card');
            if (oldCard) oldCard.remove();
            dock.setAttribute('data-fab-mode', ctx.mode);
        }
        if ($('#nme-fab-btns')) return $('#nme-fab-btns');

        const card = document.createElement('div');
        card.id = 'nme-fab-card';
        card.className = 'nme-fab-card';
        card.hidden = true;
        card.innerHTML = [
            '<div class="nme-fab-head">',
            '  <span id="nme-fab-title" class="nme-fab-title"></span>',
            '  <button id="nme-fab-close" class="nme-fab-close" type="button" aria-label="关闭">✕</button>',
            '</div>',
            '<div id="nme-fab-body" class="nme-fab-body"></div>'
        ].join('');

        const btns = document.createElement('div');
        btns.id = 'nme-fab-btns';
        btns.className = 'nme-fab-btns';

        if (ctx.mode === 'detail') {
            const b = document.createElement('button');
            b.id = 'nme-fab-ai';
            b.className = 'nme-fab-btn nme-fab-btn-ai';
            b.type = 'button';
            b.textContent = '✦ AI';
            b.title = 'AI 翻译 / 分析';
            btns.appendChild(b);
        }

        const d = document.createElement('button');
        d.id = 'nme-fab-dl';
        d.className = 'nme-fab-btn nme-fab-btn-dl';
        d.type = 'button';
        d.textContent = ctx.mode === 'collection' ? '⬇ 合集下载' : '⬇ 下载';
        d.title = ctx.mode === 'collection' ? '合集批量下载' : '文件列表与一键下载';
        btns.appendChild(d);

        // AI 接口配置：独立浮动按钮，直接打开配置弹窗
        const c = document.createElement('button');
        c.id = 'nme-fab-cfg';
        c.className = 'nme-fab-btn nme-fab-btn-cfg';
        c.type = 'button';
        c.textContent = '⚙ 配置';
        c.title = 'AI 接口配置';
        btns.appendChild(c);

        dock.appendChild(card);
        dock.appendChild(btns);

        card.querySelector('#nme-fab-close').addEventListener('click', function () { closeFab(); });
        if (ctx.mode === 'detail') {
            btns.querySelector('#nme-fab-ai').addEventListener('click', function () { toggleFab(FAB_SEC_AI); });
        }
        btns.querySelector('#nme-fab-dl').addEventListener('click', function () { toggleFab(FAB_SEC_DL); });
        btns.querySelector('#nme-fab-cfg').addEventListener('click', function () {
            closeFab();
            openAiSettings();
        });

        return btns;
    }

    /** 浮层里的小节（AI / 下载）之间的切换 */
    function setFabSection(sec) {
        const card = $('#nme-fab-card');
        if (!card) return;
        const secs = card.querySelectorAll('.nme-fab-sec');
        for (let i = 0; i < secs.length; i++) {
            secs[i].classList.toggle('nme-fab-sec-on', secs[i].getAttribute('data-sec') === sec);
        }
        const titles = { ai: 'N网 AI · 翻译与分析', dl: 'N网 下载 · 文件与直链' };
        const t = $('#nme-fab-title');
        if (t) t.textContent = titles[sec] || '';
        const btns = $('#nme-fab-btns');
        if (btns) {
            const ba = btns.querySelector('#nme-fab-ai');
            const bd = btns.querySelector('#nme-fab-dl');
            if (ba) ba.classList.toggle('nme-fab-btn-on', sec === FAB_SEC_AI);
            if (bd) bd.classList.toggle('nme-fab-btn-on', sec === FAB_SEC_DL);
        }
    }

    function openFab(sec) {
        const card = $('#nme-fab-card');
        if (!card) return;
        // 面板互斥：打开 AI/下载面板时收起快捷面板，避免两个浮层叠在一起
        closeCapsule();
        card.hidden = false;
        setFabSection(sec);
    }

    function toggleFab(sec) {
        const card = $('#nme-fab-card');
        if (!card) return;
        if (!card.hidden && card.querySelector('.nme-fab-sec-on[data-sec="' + sec + '"]')) {
            closeFab();
            return;
        }
        openFab(sec);
    }

    function closeFab() {
        const card = $('#nme-fab-card');
        if (card) card.hidden = true;
        const btns = $('#nme-fab-btns');
        if (btns) {
            const ba = btns.querySelector('#nme-fab-ai');
            const bd = btns.querySelector('#nme-fab-dl');
            if (ba) ba.classList.remove('nme-fab-btn-on');
            if (bd) bd.classList.remove('nme-fab-btn-on');
        }
    }

    /** 把内容挂到浮层里的小节容器中（不再插进页面正文） */
    function fabSection(sec) {
        const body = $('#nme-fab-body');
        if (!body) return null;
        let el = body.querySelector('.nme-fab-sec[data-sec="' + sec + '"]');
        if (!el) {
            el = document.createElement('div');
            el.className = 'nme-fab-sec';
            el.setAttribute('data-sec', sec);
            body.appendChild(el);
        }
        return el;
    }

    /** 模组页 AI 工具条（挂在浮动按钮坞的「AI」小节里） */
    function mountDetailAi(ctx) {
        if (!ctx || ctx.mode !== 'detail') return;
        if ($('#nme-ai-bar')) return;
        const sec = fabSection(FAB_SEC_AI);
        if (!sec) return;

        const bar = document.createElement('div');
        bar.id = 'nme-ai-bar';
        bar.innerHTML = [
            '<div class="nme-ai-head">',
            '  <span class="nme-ai-title">N网 AI</span>',
            '  <span class="nme-ai-sub">翻译描述 / 结构化分析 / 依赖与冲突提示</span>',
            '</div>',
            '<div class="nme-ai-actions">',
            '  <button id="nme-ai-tr" class="nme-ai-btn" type="button">AI 翻译描述</button>',
            '  <button id="nme-ai-an" class="nme-ai-btn nme-ai-btn-accent" type="button">AI 分析模组</button>',
            '  <button id="nme-ai-cfg" class="nme-ai-btn" type="button">AI 配置</button>',
            '  <span id="nme-ai-status" class="nme-ai-status"></span>',
            '</div>',
            '<div id="nme-ai-out" class="nme-ai-out" hidden></div>'
        ].join('');

        sec.appendChild(bar);

        const tr = bar.querySelector('#nme-ai-tr');
        const an = bar.querySelector('#nme-ai-an');
        const cfg = bar.querySelector('#nme-ai-cfg');
        if (tr) tr.addEventListener('click', function () { runModTranslate(ctx); });
        if (an) an.addEventListener('click', function () { runModAnalyze(ctx); });
        if (cfg) cfg.addEventListener('click', openAiSettings);

        if (!aiConfigured()) aiStatus('未配置 AI 接口，先点「AI 配置」', 'warn');
    }

    async function ensureModDetail(ctx) {
        const want = Number(ctx.modId);
        if (state.modCache && Number(state.modCache.modId) === want) return state.modCache;
        // AI 条与下载条会同时挂载：复用同一次请求，避免重复打 GraphQL
        if (state.modLoading && state.modLoading.id === want) return state.modLoading.p;
        const p = fetchModDetail(ctx.domain, ctx.modId).then(function (mod) {
            state.modCache = mod;
            state.modLoading = null;
            return mod;
        }, function (e) {
            state.modLoading = null;
            throw e;
        });
        state.modLoading = { id: want, p: p };
        return p;
    }

    async function runModTranslate(ctx) {
        openFab(FAB_SEC_AI);
        const trBtn = $('#nme-ai-tr');
        const anBtn = $('#nme-ai-an');
        const cacheKey = 'tr.' + ctx.domain + '.' + ctx.modId;
        const cached = aiCacheGet(cacheKey);
        if (cached) {
            aiOutput().innerHTML = '<div class="nme-ai-card"><div class="nme-ai-card-head">AI 翻译（缓存）</div>' + aiTextHtml(cached.v) + '</div>';
            aiStatus('已使用缓存结果', 'ok');
            return;
        }
        if (!aiConfigured()) { openAiSettings(); return; }
        if (trBtn) trBtn.disabled = true;
        if (anBtn) anBtn.disabled = true;
        aiStatus('正在拉取描述并翻译…', 'busy');
        try {
            const mod = await ensureModDetail(ctx);
            const raw = bbcodeToText(mod.description || '') || bbcodeToText(mod.summary || '');
            if (!raw) throw new Error('该模组没有可翻译的描述');
            if (raw.length > 2000) aiStatus('正在翻译 ' + raw.length + ' 字符（超出部分会截断）…', 'busy');
            const prompt = '你是游戏模组文档翻译。把下面的 Nexus Mods 模组描述从英文翻译成简体中文。\n' +
                '要求：\n' +
                '1. 保留原文的段落、标题、列表、文件名、路径和链接；\n' +
                '2. 专有名词（模组名、工具名、游戏内名词、文件路径）保留英文；\n' +
                '3. 不要添加原文没有的内容，不要写前言或后记；\n' +
                '4. 直接输出翻译后的正文。\n\n' +
                '模组名：' + (mod.name || '') + '\n' +
                '原文：\n"""\n' + raw.slice(0, AI_MAX_DESC) + '\n"""';
            const text = await callAi(prompt, { temperature: 0.2, maxTokens: 4096 });
            const clean = text.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
            aiCacheSet(cacheKey, clean);
            aiOutput().innerHTML = '<div class="nme-ai-card"><div class="nme-ai-card-head">AI 翻译' +
                '<span class="nme-ai-tip">' + escapeHtml(modMetaLine(mod)) + '</span></div>' +
                aiTextHtml(clean) + '</div>';
            aiStatus('翻译完成', 'ok');
        } catch (e) {
            aiStatus((e && e.message) || String(e), 'err');
        } finally {
            if (trBtn) trBtn.disabled = false;
            if (anBtn) anBtn.disabled = false;
        }
    }

    function renderModAnalysis(data, mod) {
        const features = (data.features || []).map(function (f) {
            return '<li>' + escapeHtml(typeof f === 'string' ? f : JSON.stringify(f)) + '</li>';
        }).join('');
        const rows = [
            ['一句话', data.oneliner],
            ['安装', data.install],
            ['依赖', data.requirements],
            ['冲突/注意', data.conflicts],
            ['适合', data.audience],
            ['风险', data.risk]
        ].filter(function (r) { return r[1]; }).map(function (r) {
            return '<div class="nme-ai-kv"><span class="nme-ai-k">' + r[0] + '</span><span class="nme-ai-v">' + escapeHtml(r[1]) + '</span></div>';
        }).join('');
        return '<div class="nme-ai-card">' +
            '<div class="nme-ai-card-head">AI 分析<span class="nme-ai-tip">' + escapeHtml(modMetaLine(mod)) + '</span></div>' +
            rows +
            (features ? '<div class="nme-ai-sec-title">主要功能</div><ul class="nme-ai-list">' + features + '</ul>' : '') +
            '</div>';
    }

    async function runModAnalyze(ctx) {
        openFab(FAB_SEC_AI);
        const trBtn = $('#nme-ai-tr');
        const anBtn = $('#nme-ai-an');
        const cacheKey = 'an.' + ctx.domain + '.' + ctx.modId;
        const cached = aiCacheGet(cacheKey);
        if (cached) {
            aiOutput().innerHTML = renderModAnalysis(cached.v, state.modCache || { name: '' });
            aiStatus('已使用缓存结果', 'ok');
            return;
        }
        if (!aiConfigured()) { openAiSettings(); return; }
        if (trBtn) trBtn.disabled = true;
        if (anBtn) anBtn.disabled = true;
        aiStatus('正在分析模组…', 'busy');
        try {
            const mod = await ensureModDetail(ctx);
            const desc = bbcodeToText(mod.description || '').slice(0, AI_MAX_DESC);
            const prompt = '你是资深模组安装顾问。根据下面的 Nexus Mods 模组信息，输出 JSON（只输出 JSON，不要 markdown 代码块）：\n' +
                '{\n' +
                '  "oneliner": "一句话说明这个 mod 做什么",\n' +
                '  "features": ["主要功能点", "..."],\n' +
                '  "install": "安装步骤（含目标路径）",\n' +
                '  "requirements": "前置依赖 / 游戏版本要求，没有就写 无",\n' +
                '  "conflicts": "已知冲突或注意事项，没有就写 无",\n' +
                '  "audience": "适合什么玩家",\n' +
                '  "risk": "低/中/高 + 一句原因"\n' +
                '}\n\n' +
                '只依据给到的信息，不要编造。信息：\n' +
                '名称：' + (mod.name || '') + '\n' +
                '简介：' + (mod.summary || '') + '\n' +
                '元数据：' + modMetaLine(mod) + '\n' +
                '描述：\n"""\n' + desc + '\n"""';
            const text = await callAi(prompt, { temperature: 0.2, maxTokens: 1600 });
            const data = parseAiJson(text);
            aiCacheSet(cacheKey, data);
            aiOutput().innerHTML = renderModAnalysis(data, mod);
            aiStatus('分析完成', 'ok');
        } catch (e) {
            aiStatus((e && e.message) || String(e), 'err');
        } finally {
            if (trBtn) trBtn.disabled = false;
            if (anBtn) anBtn.disabled = false;
        }
    }


    // ==================== AI 配置弹窗 ====================

    /** 兼容旧调用点：AI 功能未配置时仍会弹设置面板，并聚焦 AI 分区 */
    function openAiSettings() { openSettings('ai'); }

    /**
     * 脚本设置面板（1.6.x）：把原先散在脚本菜单里的配置集中到一处。
     * 三个分区：下载 / 界面 / AI，保存时分别写 CFG 与 aiCfg。
     * 分区样式复用原有 .nme-ai-modal 体系，只补了分区标题与勾选行。
     */
    function openSettings(focusSection) {
        if ($('#nme-ai-cfg-modal')) return;
        const dlFolder = typeof CFG.dlFolder === 'boolean' ? CFG.dlFolder : true;
        const dlImagesWithMod = typeof CFG.dlImagesWithMod === 'boolean' ? CFG.dlImagesWithMod : false;
        const modal = document.createElement('div');
        modal.id = 'nme-ai-cfg-modal';
        modal.innerHTML = [
            '<div class="nme-ai-modal">',
            '  <div class="nme-ai-modal-title">脚本设置</div>',

            '  <div class="nme-cfg-section" data-sec="download">下载</div>',
            '  <div class="nme-cfg-row">',
            '    <span class="nme-cfg-label">保存目录</span>',
            '    <button id="nme-cfg-dir" class="nme-ai-btn" type="button">读取中…</button>',
            '  </div>',
            '  <div class="nme-ai-modal-help">选一次目录后，下载会自动在该目录下建 <code>游戏名/Mod 名/</code>；不选则退回浏览器下载目录，那条通道是否建文件夹取决于脚本管理器。</div>',
            '  <label class="nme-cfg-check"><input id="nme-cfg-folder" type="checkbox"> 按 mod 建文件夹</label>',
            '  <label class="nme-cfg-check"><input id="nme-cfg-imgwith" type="checkbox"> 下载安装包时附带图片</label>',
            '  <div class="nme-cfg-row">',
            '    <span class="nme-cfg-label">每个 mod 最多图片数</span>',
            '    <input id="nme-cfg-imglimit" class="nme-cfg-num" type="number" min="0" max="50" step="1">',
            '  </div>',
            '  <div class="nme-cfg-row">',
            '    <span class="nme-cfg-label">合集下载间隔（秒）</span>',
            '    <input id="nme-cfg-gap" class="nme-cfg-num" type="number" min="1" max="60" step="1">',
            '  </div>',
            '  <label class="nme-cfg-check"><input id="nme-cfg-skipwait" type="checkbox"> 跳过下载等待页</label>',

            '  <div class="nme-cfg-section" data-sec="ui">界面</div>',
            '  <div class="nme-cfg-row">',
            '    <span class="nme-cfg-label">每页条数</span>',
            '    <select id="nme-cfg-pagesize" class="nme-cfg-num"></select>',
            '  </div>',
            '  <label class="nme-cfg-check"><input id="nme-cfg-zhui" type="checkbox"> 界面中文化</label>',
            '  <label class="nme-cfg-check"><input id="nme-cfg-badges" type="checkbox"> 模组语言徽章</label>',

            '  <div class="nme-cfg-section" data-sec="ai">AI（翻译 / 分析）</div>',
            '  <div class="nme-ai-modal-help">兼容 OpenAI / DeepSeek 的 <code>/chat/completions</code> 接口。Key 只保存在本机脚本存储里，仅发送模组文本，不发送 Nexus Cookie。</div>',
            '  <label class="nme-ai-field"><span>API 地址</span><input id="nme-cfg-url" type="text" spellcheck="false"></label>',
            '  <label class="nme-ai-field"><span>API Key</span><input id="nme-cfg-key" type="password" spellcheck="false" placeholder="sk-..."></label>',
            '  <label class="nme-ai-field"><span>模型</span><input id="nme-cfg-model" type="text" spellcheck="false" placeholder="deepseek-chat"></label>',

            '  <div class="nme-ai-modal-foot">',
            '    <span id="nme-cfg-status" class="nme-ai-status"></span>',
            '    <button id="nme-cfg-test" class="nme-ai-btn" type="button">测试 AI</button>',
            '    <button id="nme-cfg-cancel" class="nme-ai-btn" type="button">取消</button>',
            '    <button id="nme-cfg-save" class="nme-ai-btn nme-ai-btn-accent" type="button">保存</button>',
            '  </div>',
            '</div>'
        ].join('');
        document.body.appendChild(modal);

        const pick = function (id) { return modal.querySelector(id); };
        const dirBtn = pick('#nme-cfg-dir');
        const folderEl = pick('#nme-cfg-folder');
        const imgWithEl = pick('#nme-cfg-imgwith');
        const imgLimitEl = pick('#nme-cfg-imglimit');
        const gapEl = pick('#nme-cfg-gap');
        const skipWaitEl = pick('#nme-cfg-skipwait');
        const pageSizeEl = pick('#nme-cfg-pagesize');
        const zhUIEl = pick('#nme-cfg-zhui');
        const badgesEl = pick('#nme-cfg-badges');
        const urlEl = pick('#nme-cfg-url');
        const keyEl = pick('#nme-cfg-key');
        const modelEl = pick('#nme-cfg-model');
        const statusEl = pick('#nme-cfg-status');

        // 回填当前值
        folderEl.checked = dlFolder;
        imgWithEl.checked = dlImagesWithMod;
        imgLimitEl.value = String(CFG.dlImgLimit == null ? 12 : CFG.dlImgLimit);
        gapEl.value = String(CFG.dlGap == null ? 5 : CFG.dlGap);
        skipWaitEl.checked = !!CFG.skipWait;
        const sizeChoices = [20, 40, 60, 80];
        sizeChoices.forEach(function (size) {
            const opt = document.createElement('option');
            opt.value = String(size);
            opt.textContent = size + ' 条';
            if (Number(CFG.pageSize) === size) opt.selected = true;
            pageSizeEl.appendChild(opt);
        });
        zhUIEl.checked = !!CFG.zhUI;
        badgesEl.checked = !!CFG.badges;
        urlEl.value = aiCfg.url || AI_DEFAULT_URL;
        keyEl.value = aiCfg.key || '';
        modelEl.value = aiCfg.model || AI_DEFAULT_MODEL;

        const setStatus = function (text, kind) {
            statusEl.textContent = text || '';
            statusEl.className = 'nme-ai-status' + (kind ? ' nme-ai-status-' + kind : '');
        };
        const close = function () { modal.remove(); };

        // 保存目录按钮：显示当前目录名，点击重选或重新授权
        const refreshDir = async function () {
            let handle = null;
            try { handle = await dlLoadRootHandle(); } catch (e) { handle = null; }
            if (!handle) {
                dirBtn.textContent = '选择保存目录';
                return;
            }
            const granted = await dlPermissionGranted(handle);
            dirBtn.textContent = granted ? ('已选：' + handle.name) : ('重新授权：' + handle.name);
        };
        refreshDir();
        dirBtn.addEventListener('click', async function () {
            const handle = await chooseArchiveRoot();
            if (handle) await refreshDir();
        });

        modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
        pick('#nme-cfg-cancel').addEventListener('click', close);

        pick('#nme-cfg-save').addEventListener('click', function () {
            const clampNumber = function (raw, min, max, fallback) {
                const value = parseInt(raw, 10);
                if (!Number.isFinite(value)) return fallback;
                return Math.min(max, Math.max(min, value));
            };
            const oldPageSize = Number(CFG.pageSize);
            const oldZhUI = !!CFG.zhUI;
            const oldBadges = !!CFG.badges;

            CFG.dlFolder = folderEl.checked;
            CFG.dlImagesWithMod = imgWithEl.checked;
            CFG.dlImgLimit = clampNumber(imgLimitEl.value, 0, 50, 12);
            CFG.dlGap = clampNumber(gapEl.value, 1, 60, 5);
            CFG.skipWait = skipWaitEl.checked;
            CFG.pageSize = clampNumber(pageSizeEl.value, 20, 80, 80);
            CFG.zhUI = zhUIEl.checked;
            CFG.badges = badgesEl.checked;
            saveCfg();

            aiCfg.url = urlEl.value.trim() || AI_DEFAULT_URL;
            aiCfg.key = keyEl.value.trim();
            aiCfg.model = modelEl.value.trim() || AI_DEFAULT_MODEL;
            saveAiCfg();

            // 列表相关的设置只影响下一次渲染，直接告诉用户要刷新，别让人以为没生效
            const needReload = oldPageSize !== CFG.pageSize || oldZhUI !== CFG.zhUI || oldBadges !== CFG.badges;
            close();
            if (needReload) {
                showToast('设置已保存', '界面相关项需刷新页面后生效', 'ok');
            } else {
                showToast('设置已保存', '下载设置已立即生效', 'ok');
            }
        });

        pick('#nme-cfg-test').addEventListener('click', async function () {
            const btn = this;
            btn.disabled = true;
            setStatus('测试中…', 'busy');
            try {
                const text = await callAi('只回复两个字：可用', {
                    maxTokens: 32,
                    temperature: 0,
                    cfg: {
                        url: urlEl.value.trim() || AI_DEFAULT_URL,
                        key: keyEl.value.trim(),
                        model: modelEl.value.trim() || AI_DEFAULT_MODEL
                    }
                });
                setStatus('连接成功：' + text.trim().slice(0, 20), 'ok');
            } catch (e) {
                setStatus((e && e.message) || String(e), 'err');
            } finally {
                btn.disabled = false;
            }
        });

        // 从 AI 相关入口打开时，把视图滚到 AI 区，免得用户还得自己找
        if (focusSection === 'ai') {
            const aiSection = modal.querySelector('.nme-cfg-section[data-sec="ai"]');
            if (aiSection && aiSection.scrollIntoView) aiSection.scrollIntoView({ block: 'nearest' });
        }
    }

    // ==================== 下载增强 ====================
    // 参考 Greasy Fork 三个脚本的机制（见 reference/）：
    //   - 官方 GenerateDownloadUrl 接口直接换直链，不抓下载页 DOM
    //   - 失败时回退到 ?tab=files&file_id=...&nmm=1 页面里的 data-download-url
    //   - 合集用 GraphQL collectionRevision(slug) 取 modFiles，逐个人工触发下载
    //   - 批量下载带间隔、连续下载上限、冷却、断点历史

    const DL_GEN = '/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl';
    const DL_HISTORY_KEY = 'nme.dlhistory';
    const DL_RATE_LIMIT = 150;   // 连续下载多少个后强制冷却
    const DL_COOLDOWN = 300;     // 冷却秒数
    const DL_MAX_LOG = 80;
    const DL_REPEAT_GUARD = 30000;  // 同一文件 30 秒内不重复触发，避免重复扣次数

    /**
     * 下载错误分类（借鉴 Vortex 的边界处理）：
     * 可重试的（网络/接口偶发）与必须停下的（未登录/被拦截/限流/无权限）分开。
     */
    class DlError extends Error {
        constructor(code, message) {
            super(message);
            this.name = 'DlError';
            this.code = code;
        }
        get fatal() {
            return this.code === 'AUTH' || this.code === 'FORBIDDEN' ||
                this.code === 'CLOUDFLARE' || this.code === 'RATE_LIMIT';
        }
    }

    const dlRecent = {};  // fileId → 最近一次触发时间
    function dlTooSoon(fileId) {
        const t = dlRecent[fileId];
        return !!t && (Date.now() - t) < DL_REPEAT_GUARD;
    }
    function markDl(fileId) { dlRecent[fileId] = Date.now(); }

    const Q_MOD_FILES = `query ModFiles($modId: ID!, $gameId: ID!) {
  modFiles(modId: $modId, gameId: $gameId) {
    fileId name version sizeInBytes category primary totalDownloads uri
  }
}`;

    const Q_COLLECTION_MODS = `query CollectionRevisionMods($slug: String!, $domain: String) {
  collectionRevision(slug: $slug, domainName: $domain, viewAdultContent: true) {
    modCount revisionNumber totalSize
    modFiles {
      optional
      fileId
      file { name sizeInBytes mod { modId name pictureUrl game { id domainName name } } }
    }
  }
}`;

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function isLoggedIn() {
        // 页面未水合时 USER_ID 与登录链接都可能不存在，无法可靠判断；
        // 只有能确定 USER_ID 时才拦截，其余交给接口 401/403 或文件页的登录链接提示。
        if (typeof window.USER_ID !== 'undefined') return !!window.USER_ID;
        return true;
    }

    function dlStatus(text, kind) {
        const el = $('#nme-dl-status');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'nme-ai-status' + (kind ? ' nme-ai-status-' + kind : '');
    }

    /** 官方接口：fid + game_id → { url } */
    async function generateDownloadUrl(fileId, gameId) {
        let res;
        try {
            res = await fetch(DL_GEN, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: 'fid=' + encodeURIComponent(fileId) + '&game_id=' + encodeURIComponent(gameId)
            });
        } catch (e) {
            throw new DlError('NETWORK', '网络错误，无法连接 Nexus');
        }
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                throw new DlError('AUTH', '没有下载权限（登录失效、需要 Premium，或作者未开放该文件）');
            }
            if (res.status === 429) throw new DlError('RATE_LIMIT', '请求过于频繁，Nexus 已限流');
            throw new DlError('API', '生成下载链接失败（HTTP ' + res.status + '）');
        }
        let data;
        try { data = await res.json(); } catch (e) { throw new DlError('API', '接口返回不是有效 JSON'); }
        if (!data || !data.url) throw new DlError('API', '接口没有返回下载地址');
        // 接口有时会一并给出真实文件名，比直链末段更准（CDN 末段常是混淆名）
        return {
            url: decodeDlUrl(data.url),
            filename: String(data.filename || data.fileName || data.name || '')
        };
    }

    function decodeDlUrl(u) {
        return String(u || '')
            .replace(/\\\//g, '/')
            .replace(/&amp;/g, '&')
            .replace(/&#38;/g, '&')
            .replace(/\\u0026/gi, '&');
    }

    /** 从文件页 HTML 兜底提取直链 */
    function extractDownloadUrl(html) {
        const patterns = [
            /const downloadUrl\s*=\s*['"]([^'"]+)['"]/,
            /id="slowDownloadButton"[^>]*data-download-url="([^"]+)"/,
            /data-download-url\s*=\s*["']([^"']+)["']/,
            /href\s*=\s*["'](nxm:\/\/[^"']+)["']/i
        ];
        for (let i = 0; i < patterns.length; i++) {
            const m = html.match(patterns[i]);
            if (m && m[1]) return decodeDlUrl(m[1]);
        }
        return '';
    }

    /** 统一取直链：官方接口优先，HTML 兜底 */
    async function resolveDownloadUrl(domain, modId, fileId, gameId) {
        if (!isLoggedIn()) throw new DlError('AUTH', '请先登录 Nexus Mods 账号');

        let apiError = null;
        try {
            return await generateDownloadUrl(fileId, gameId);
        } catch (e) {
            apiError = e;
            if (e && e.code === 'NETWORK') await sleep(800);
        }

        const pageUrl = 'https://www.nexusmods.com/' + encodeURIComponent(domain) + '/mods/' + modId +
            '?tab=files&file_id=' + encodeURIComponent(fileId) + '&nmm=1';
        let html = '', status = 0;
        try {
            const res = await fetch(pageUrl, { credentials: 'include' });
            status = res.status;
            html = res.ok ? await res.text() : '';
        } catch (e) {
            throw new DlError('NETWORK', '网络错误，无法打开文件页');
        }

        if (!html) {
            if (status === 429) throw new DlError('RATE_LIMIT', '请求过于频繁，Nexus 已限流');
            if (status === 401 || status === 403) {
                throw new DlError('FORBIDDEN', '没有下载权限（登录失效、需要 Premium，或作者未开放该文件）');
            }
            throw apiError || new DlError('API', '文件页返回空内容（HTTP ' + status + '）');
        }

        if (html.includes('class="replaced-login-link"')) throw new DlError('AUTH', '请先登录 Nexus Mods 账号');
        if (html.includes('Just a moment')) {
            throw new DlError('CLOUDFLARE', '触发 Cloudflare 校验，请手动打开该文件页完成校验');
        }
        if (html.includes('temporarily suspended')) throw new DlError('RATE_LIMIT', 'Nexus 临时限制了下载，请稍后再试');

        const url = extractDownloadUrl(html);
        if (!url) {
            if (apiError) throw apiError;
            throw new DlError('NO_URL', '未取到下载地址（该文件可能需要手动确认或 Premium）');
        }
        return { url: url, filename: '' };
    }

    /** 网络类错误重试一次；被拦截/无权限不重试 */
    async function resolveWithRetry(domain, modId, fileId, gameId) {
        try {
            return await resolveDownloadUrl(domain, modId, fileId, gameId);
        } catch (e) {
            if (e && e.code === 'NETWORK') {
                await sleep(1500);
                return await resolveDownloadUrl(domain, modId, fileId, gameId);
            }
            throw e;
        }
    }

    /** 触发下载：a[download] 点击，不离开当前页；nxm:// 交给 Vortex */
    function triggerDownload(url, fileName) {
        if (/^nxm:\/\//i.test(url)) { location.href = url; return; }
        const a = document.createElement('a');
        a.href = url;
        // 没有扩展名时交给 Content-Disposition 决定，避免存成无后缀文件
        const name = (fileName || '').trim();
        if (name && /\.[a-z0-9]{1,8}$/i.test(name)) a.download = name;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { if (a.parentElement) a.remove(); }, 1000);
    }

    // ---------- 按 mod 归档下载（1.4.0 新增）----------
    //
    // 目标：一次下载 = 一个 <Mod名>/ 文件夹，里面放该 mod 的安装包与预览图。
    //
    // 为什么不能沿用上面的 triggerDownload：
    //   a[download] 的 download 属性只是「建议文件名」，不含路径。Chrome 会把其中的 / 换成 _，
    //   靠它永远建不出文件夹。要建子目录只能走扩展的 downloads API（GM_download → filename）。
    //
    // ScriptCat 的两个源码级行为，决定参数怎么写（写错就整条链路失效）：
    //   1) GM_download 默认 downloadMode='native'，会先用 GM_xmlhttpRequest 把文件整个读进内存，
    //      几百 MB 的 mod 会拖死标签页。必须显式传 downloadMode:'browser'，
    //      它才是「URL 直传 chrome.downloads.download」，原生下载、零内存占用。
    //   2) 它只把 [\x00-\x1F\\:*?"<>|] 换成 '-'，正斜杠 / 不在其中，
    //      所以 name:'Mod名/file.zip' 会原样传到 filename，Chrome 据此创建子目录。
    //
    // 图片为什么也走 GM_download：
    //   fetch 图片会被 staticdelivery.nexusmods.com 的 CORS 拦住；
    //   跨域 <a download> 指定的文件名会被浏览器忽略（只会跳转打开图片）。
    //   只有 GM_download 能把图片按指定相对路径落进目录。

    const DL_FOLDER_BAD = /[\x00-\x1F\\/:*?"<>|]/g;  // 目录名里一个都不许留（/ 也要，否则会多建一层）
    const DL_FOLDER_MAX = 80;                         // 目录名长度上限，避开各系统路径长度限制
    const DL_FILE_NAME_MAX = 120;                     // 文件名长度上限（保留扩展名）
    const DL_IMG_GAP_MS = 400;                        // 相邻图片下载间隔，避免一次弹太多下载被浏览器拦
    const DL_FILE_EXT = /\.(zip|7z|rar|tar|gz|tgz|xz|bz2|zst|fomod|omod|exe|bin|pak|jar|pdf|txt)$/i;
    const DL_IMG_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

    // ---------- File System Access 通道（自己建目录，不依赖管理器）----------
    //
    // 为什么需要它：GM_download 能不能建子目录，取决于管理器是否把 name 原样传给
    // chrome.downloads.filename —— 实测在部分环境里没生效，文件直接落在下载根目录。
    // 这条路不经过管理器、不经过浏览器下载设置：脚本自己 getDirectoryHandle(名字,{create:true})
    // 建目录、自己 createWritable() 写文件，路径 100% 可控，还能把根目录指到任意位置（含网络盘）。
    //
    // 代价：用户点一次「选择保存目录」授权。handle 存 IndexedDB 之后一直复用；
    // 浏览器重启后权限退回 prompt，面板会提示重新授权。

    const DL_DB_NAME = 'nme-archive';
    const DL_DB_VERSION = 1;
    const DL_DB_STORE = 'root';
    const DL_DB_KEY = 'dir';
    const DL_ROOT_NAME_KEY = 'nme.archive.rootName';   // GM 存储里的目录名标记，用于诊断记录丢失
    const DL_PROGRESS_THROTTLE_MS = 500;   // 进度刷面板的最小间隔，避免大文件把 DOM 刷爆

    /** 页面真实的 showDirectoryPicker：油猴沙箱里的 window 可能是代理对象 */
    function dlPickerApi() {
        const realWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
        if (realWindow && typeof realWindow.showDirectoryPicker === 'function') {
            return realWindow.showDirectoryPicker.bind(realWindow);
        }
        return null;
    }

    function dlOpenDb() {
        // 用页面真实 indexedDB：沙箱若把 indexedDB 隔离，handle 会存进另一个库，下次读不到
        const idb = (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow.indexedDB)
            ? unsafeWindow.indexedDB
            : indexedDB;
        return new Promise(function (resolve, reject) {
            let request;
            try { request = idb.open(DL_DB_NAME, DL_DB_VERSION); }
            catch (e) { reject(e); return; }
            request.onupgradeneeded = function () {
                const db = request.result;
                if (!db.objectStoreNames.contains(DL_DB_STORE)) db.createObjectStore(DL_DB_STORE);
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error || new Error('IndexedDB 打不开')); };
        });
    }

    async function dlSaveRootHandle(handle) {
        const db = await dlOpenDb();
        try {
            await new Promise(function (resolve, reject) {
                const tx = db.transaction(DL_DB_STORE, 'readwrite');
                tx.objectStore(DL_DB_STORE).put(handle, DL_DB_KEY);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('保存目录授权失败')); };
            });
        } finally { db.close(); }
    }

    async function dlLoadRootHandle() {
        const db = await dlOpenDb();
        try {
            return await new Promise(function (resolve, reject) {
                const tx = db.transaction(DL_DB_STORE, 'readonly');
                const request = tx.objectStore(DL_DB_STORE).get(DL_DB_KEY);
                request.onsuccess = function () { resolve(request.result || null); };
                request.onerror = function () { reject(request.error || new Error('读取目录授权失败')); };
            });
        } finally { db.close(); }
    }

    /** 授权是否仍有效。只查询不弹窗：requestPermission 必须在用户手势里调用 */
    async function dlPermissionGranted(handle) {
        if (!handle || typeof handle.queryPermission !== 'function') return false;
        try { return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted'; }
        catch (e) { return false; }
    }

    /** 让用户选一次保存根目录（必须在点击事件里调用，浏览器要求用户手势） */
    async function chooseArchiveRoot() {
        const picker = dlPickerApi();
        if (!picker) {
            showToast('浏览器不支持', '当前浏览器没有 File System Access（需要 Chrome / Edge），只能落到浏览器下载目录', 'err');
            return null;
        }
        try {
            const handle = await picker({ mode: 'readwrite', id: 'nme-archive-root' });
            await dlSaveRootHandle(handle);
            // GM 存储留个名字：万一下次 IDB 读不到，能区分「没选过」和「选过但记录丢了」
            try { GM_setValue(DL_ROOT_NAME_KEY, handle.name); } catch (ignored) { /* 存不了不影响主流程 */ }
            showToast('已选择保存目录', '之后下载会自动存到「' + handle.name + '/<Mod名>/」', 'ok');
            return handle;
        } catch (e) {
            if (e && e.name === 'AbortError') return null;   // 用户取消，不算失败
            showToast('选择目录失败', (e && e.message) || String(e), 'err');
            return null;
        }
    }

    /**
     * 取可用根目录，授权失效时在用户手势窗口内自动恢复。
     *
     * 为什么必须「点击后立刻调用」：requestPermission 依赖用户激活状态（约 5 秒），
     * 中间只要先 await 过一次网络请求就可能失效，于是静默降级到浏览器下载、不再建文件夹。
     * 返回值带 reason，调用方据此决定是提示去选目录、还是提示重新授权。
     */
    async function dlEnsureRoot() {
        let handle = null;
        try { handle = await dlLoadRootHandle(); } catch (e) { handle = null; }
        if (!handle) {
            // IDB 读不到：可能是沙箱隔离了 indexedDB，也可能是浏览器清了站点数据。
            // 用 GM 存储里的名字标记判断是「从没选过」还是「选过但记录丢了」。
            let remembered = '';
            try { remembered = GM_getValue(DL_ROOT_NAME_KEY, '') || ''; } catch (ignored) { remembered = ''; }
            return { handle: null, reason: remembered ? 'lost' : 'not-chosen' };
        }
        const permission = { mode: 'readwrite' };
        try {
            if (await handle.queryPermission(permission) === 'granted') {
                return { handle: handle, reason: 'ok' };
            }
            const granted = await handle.requestPermission(permission);
            if (granted === 'granted') return { handle: handle, reason: 'renewed' };
            return { handle: null, reason: 'denied' };
        } catch (e) {
            return { handle: null, reason: 'error' };
        }
    }

    /** 把 dlEnsureRoot 的 reason 翻成用户能看懂的一句话 */
    function dlRootProblemText(reason) {
        if (reason === 'not-chosen') return '还没选保存目录';
        if (reason === 'lost') return '保存目录记录丢失（浏览器可能清了站点数据），需要重选一次';
        if (reason === 'denied') return '保存目录授权被拒绝';
        if (reason === 'error') return '保存目录授权状态异常';
        return '';
    }

    /**
     * 拼 <游戏名>/<Mod名> 目录路径。游戏名取不到时只留 Mod 名一层，
     * 不要用 unknown-game 之类占位目录把文件埋起来。
     */
    function archiveFolderPath(gameName, modFolder) {
        const mod = sanitizeFolderName(modFolder, 'unknown-mod');
        const game = String(gameName || '').trim() ? sanitizeFolderName(gameName, '') : '';
        return game ? game + '/' + mod : mod;
    }

    /**
     * 当前页面的游戏显示名。
     * 面包屑里第一个是「游戏」总入口，第二个才是具体游戏页；
     * 只认 /games/<domain> 这一层，避开 /games/<domain>/mods 之类的子链接。
     */
    function pickGameNameFromDom() {
        const links = document.querySelectorAll('#breadcrumb a[href*="/games/"]');
        for (let i = 0; i < links.length; i++) {
            const href = links[i].getAttribute('href') || '';
            if (!/\/games\/[^/]+\/?$/.test(href)) continue;
            const text = (links[i].textContent || '').trim();
            if (text) return text;
        }
        return '';
    }

    /** GM_xmlhttpRequest 取整个响应为 blob（跨域兜底通道） */
    function dlFetchBlobViaGm(url, onProgress) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                timeout: 0,
                onprogress: function (event) {
                    if (typeof onProgress === 'function') onProgress({ loaded: event.loaded, total: event.total });
                },
                onload: function (response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve({
                            blob: response.response,
                            headers: response.responseHeaders || '',
                            finalUrl: response.finalUrl || ''
                        });
                    } else {
                        reject(new Error('HTTP ' + response.status));
                    }
                },
                onerror: function () { reject(new Error('网络错误')); },
                ontimeout: function () { reject(new Error('下载超时')); }
            });
        });
    }

    /**
     * 把 url 流式写入 dirHandle/name。
     *
     * 关键顺序：先把数据拿到手，再创建文件。
     * 反过来（先 getFileHandle({create:true}) 再 fetch）一旦请求失败，
     * abort() 只丢弃写入内容、不会删掉已创建的文件，磁盘上就留下一个 0 字节的压缩包。
     * 另外无论走哪条通道，最后都校验写入字节数，0 字节一律删文件并报错。
     */
    async function dlWriteUrlToFile(dirHandle, fileNameHint, url, onProgress) {
        let loadedBytes = 0;
        let finalName = sanitizeFileName(fileNameHint, 'file.zip');
        try {
            const response = await dlFetchForDownload(url);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            // 响应到手才知道真实文件名（重定向之后才有 CDN 直链）
            finalName = dlResolveFinalFileName(response, fileNameHint);
            const fileName = finalName;
            if (!response.body || typeof response.body.getReader !== 'function') {
                const buffer = await response.arrayBuffer();
                loadedBytes = buffer.byteLength;
                await dlWriteBuffer(dirHandle, fileName, buffer);
            } else {
                const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
                const writable = await fileHandle.createWritable();
                const total = Number(response.headers.get('content-length') || 0);
                const reader = response.body.getReader();
                try {
                    for (;;) {
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        await writable.write(chunk.value);
                        loadedBytes += chunk.value.byteLength;
                        if (typeof onProgress === 'function') onProgress({ loaded: loadedBytes, total: total });
                    }
                    await writable.close();
                } catch (streamError) {
                    try { await writable.abort(); } catch (ignored) { /* 已失败，忽略 */ }
                    throw streamError;
                }
            }
        } catch (fetchError) {
            // 切后台主动中止时直接抛出：交给前台的守卫处理，
            // 绝不能落到 GM_xhr 兜底，否则会把整个文件读进内存
            if (dlIsAbortError(fetchError)) throw fetchError;
            // fetch 通道失败（CORS / 403 / 网络）：改用 GM_xhr 取完整 blob 再写
            if (typeof GM_xmlhttpRequest !== 'function') {
                await dlRemoveEntry(dirHandle, finalName);
                throw fetchError;
            }
            let fetched = null;
            try {
                fetched = await dlFetchBlobViaGm(url, onProgress);
            } catch (gmError) {
                await dlRemoveEntry(dirHandle, finalName);
                throw gmError;
            }
            if (!fetched || !fetched.blob || !fetched.blob.size) {
                await dlRemoveEntry(dirHandle, finalName);
                throw new Error('下载内容为空（0 字节）');
            }
            // 兜底通道同样定名：GM_xhr 的 finalUrl 就是重定向后的 CDN 直链
            finalName = dlPickFileNameFromParts(fetched.headers, fetched.finalUrl, fileNameHint);
            loadedBytes = fetched.blob.size;
            await dlWriteBuffer(dirHandle, finalName, fetched.blob);
        }
        if (!loadedBytes) {
            await dlRemoveEntry(dirHandle, finalName);
            throw new Error('下载内容为空（0 字节），已删除空文件');
        }
        return finalName;
    }

    /**
     * 决定最终落盘文件名。
     *
     * Nexus 给的下载地址通常不是 CDN 直链，而是会 302 到 CDN 的接口地址，
     * 直链末段拿不到真实文件名 —— 真实名（形如 <标题>-<modId>-<fileId>-<版本>-<时间戳>.zip）
     * 只在跟随重定向之后才出现，所以必须在响应到手之后才定名。
     * 优先级：Content-Disposition → 重定向后的最终 URL 末段 → 调用方提示名。
     */
    function dlResolveFinalFileName(response, hint) {
        let disposition = '';
        let finalUrl = '';
        try { disposition = response.headers.get('content-disposition') || ''; } catch (ignored) { /* 头读不到就跳过 */ }
        try { finalUrl = response.url || ''; } catch (ignored) { /* 同上 */ }
        return dlPickFileNameFromParts(disposition, finalUrl, hint);
    }

    /** 从 Content-Disposition 文本里取文件名 */
    function dlDispositionFileName(disposition) {
        const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(String(disposition || ''));
        if (!match) return '';
        const raw = match[1] || match[2] || '';
        try { return decodeURIComponent(raw); } catch (e) { return raw; }
    }

    /**
     * 从「响应头文本 + 最终 URL + 提示名」里定名。
     * GM_xmlhttpRequest 兜底通道拿不到 Response 对象，只能把它的 responseHeaders 与 finalUrl 传进来。
     */
    function dlPickFileNameFromParts(disposition, finalUrl, hint) {
        const candidates = [dlDispositionFileName(disposition), fileNameFromUrl(finalUrl), String(hint || '')];
        for (let i = 0; i < candidates.length; i++) {
            const raw = String(candidates[i] || '').trim();
            if (!raw) continue;
            const cleaned = raw.replace(DL_FOLDER_BAD, '_').trim();
            if (DL_FILE_EXT.test(cleaned)) return sanitizeFileName(cleaned, cleaned);
        }
        return sanitizeFileName(hint, 'file.zip');
    }

    /**
     * 下载文件专用的 fetch。
     *
     * 关键：不能带 credentials:'include'。
     * Nexus 的下载地址会 302 到 CDN，而 CDN 返回 access-control-allow-origin: *，
     * 按 CORS 规范带凭据的请求不允许通配符源，浏览器直接抛 TypeError: Failed to fetch（实测）。
     * 用默认的 same-origin：同源请求自动带 cookie，跨域重定向自动降级为无凭据，两种场景都成立。
     * 若仍被 401/403 拒绝（个别文件确实要凭据），再用 include 重试一次。
     */
    async function dlFetchForDownload(url, options) {
        const opts = options || {};
        const baseInit = { method: opts.method || 'GET' };
        if (opts.headers) baseInit.headers = opts.headers;
        if (opts.signal) baseInit.signal = opts.signal;
        let response = await fetch(url, baseInit);
        if (response.status === 401 || response.status === 403) {
            try {
                const retryInit = Object.assign({}, baseInit, { credentials: 'include' });
                response = await fetch(url, retryInit);
            } catch (ignored) {
                // 带凭据被 CORS 拒绝时保留第一次的响应，走原有错误处理
            }
        }
        return response;
    }

    /**
     * 探测真实文件名。
     * GM_download 是 URL 直传，下载完没法改名，只能先 HEAD 一次拿响应头；
     * 探测失败（405/403/网络）不影响下载，退回提示名。
     */
    async function dlProbeFileName(url, hint) {
        try {
            const response = await dlFetchForDownload(url, { method: 'HEAD' });
            if (response.ok) return dlResolveFinalFileName(response, hint);
        } catch (ignored) { /* 探测失败就用提示名 */ }
        return hint;
    }

    /** 整块写入：小文件与 blob 兜底通道用 */
    async function dlWriteBuffer(dirHandle, fileName, data) {
        const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(data);
        await writable.close();
    }

    /** 删掉失败时留下的空文件，避免磁盘上出现 0 字节压缩包 */
    async function dlRemoveEntry(dirHandle, fileName) {
        try { await dirHandle.removeEntry(fileName); } catch (ignored) { /* 本来就不存在就算了 */ }
    }

    /**
     * 在根目录下按 folderPath 逐级建目录并写入一个文件。
     * getDirectoryHandle 只接受单级名字，所以 <游戏名>/<Mod名> 必须自己逐段拆开建。
     */
    async function dlSaveToRoot(rootHandle, folderPath, fileName, url, onProgress, resumeKey, log) {
        const segments = String(folderPath || '').split('/').filter(Boolean);
        let dirHandle = rootHandle;
        for (let i = 0; i < segments.length; i++) {
            dirHandle = await dirHandle.getDirectoryHandle(segments[i], { create: true });
        }
        // 慢速网络优先走 OPFS 断点续传：中断后能从已下载位置接上，而不是从头再来
        if (resumeKey) {
            const got = await dlDownloadViaOpfs(url, fileName, resumeKey, onProgress, log);
            if (got) {
                const finalName = await dlCommitOpfsToDir(dirHandle, got.partName, got.fileName);
                dlResumeClear(resumeKey);
                return finalName;
            }
        }
        return await dlWriteUrlToFile(dirHandle, fileName, url, onProgress);
    }

    // ---------- OPFS 断点续传（1.6.0）----------
    //
    // 为什么单独做一套：
    //   站点限速时单个 mod 可能要下几十分钟，任何一次网络抖动都会让「直接写目标目录」从头重来。
    //   实测对比（同一浏览器）：
    //     主线程 createWritable() 写 1MB 但不 close → 目标文件恒为 0，中断即丢；
    //     Worker 里 OPFS createSyncAccessHandle 写 512KB + flush() 不 close → 已是 512KB，落盘了。
    //   所以下载先落到 OPFS 的 .part 文件（实时落盘、可续写），下完再流式复制到用户选的目录。
    //
    // 两个必须知道的约束：
    //   · createSyncAccessHandle 只在 Worker 里可用，主线程没有这个方法；
    //   · 页面 CSP 可能禁止 blob: Worker，创建失败时抛错，调用方据此降级到原直写通道。

    const DL_RESUME_PREFIX = 'nme.resume.';       // 断点记录的存储前缀
    let dlVisibilityController = null;            // 当前下载的 fetch 控制器：切后台时用它主动中止
    const DL_OPFS_PART_SUFFIX = '.nme-part';      // OPFS 里的临时文件名后缀

    /**
     * OPFS 写入 Worker 源码。
     * 只做三件事：打开/续写/关闭，每次写入后 flush() —— flush 才是「数据真的在磁盘上」的保证。
     */
    const DL_OPFS_WORKER_SRC = [
        'var handle = null;',
        'var offset = 0;',
        'self.onmessage = async function (ev) {',
        '  var msg = ev.data || {};',
        '  try {',
        '    if (msg.type === "open") {',
        '      var root = await navigator.storage.getDirectory();',
        '      var fh = await root.getFileHandle(msg.name, { create: true });',
        '      handle = await fh.createSyncAccessHandle();',
        '      if (msg.truncate) { handle.truncate(0); offset = 0; }',
        '      else { offset = msg.offset || 0; }',
        '      self.postMessage({ type: "opened", size: handle.getSize(), offset: offset });',
        '      return;',
        '    }',
        '    if (msg.type === "write") {',
        '      var bytes = new Uint8Array(msg.chunk);',
        '      handle.write(bytes, { at: offset });',
        '      offset += bytes.byteLength;',
        '      handle.flush();',
        '      self.postMessage({ type: "written", offset: offset });',
        '      return;',
        '    }',
        '    if (msg.type === "close") {',
        '      if (handle) { handle.flush(); handle.close(); }',
        '      handle = null;',
        '      self.postMessage({ type: "closed", offset: offset });',
        '    }',
        '  } catch (err) {',
        '    self.postMessage({ type: "error", message: (err && err.message) || String(err) });',
        '  }',
        '};'
    ].join('\n');

    /** 建立 OPFS Worker；CSP 禁止或环境不支持时返回 null，由调用方降级 */
    function dlCreateOpfsWorker() {
        try {
            if (typeof Worker !== 'function' || typeof Blob !== 'function') return null;
            const blob = new Blob([DL_OPFS_WORKER_SRC], { type: 'text/javascript' });
            const url = URL.createObjectURL(blob);
            const worker = new Worker(url);
            return { worker: worker, url: url };
        } catch (e) {
            return null;
        }
    }

    /** 与 Worker 一次性请求-应答（背压也靠它：不等到回执就不继续读下一块） */
    function dlWorkerRequest(worker, message, transfer) {
        return new Promise(function (resolve, reject) {
            let settled = false;
            const cleanup = function () {
                worker.removeEventListener('message', onMessage);
                worker.removeEventListener('error', onError);
            };
            const finish = function (err, data) {
                if (settled) return;
                settled = true;
                cleanup();
                if (err) reject(err); else resolve(data);
            };
            const onMessage = function (ev) {
                const data = ev.data || {};
                if (data.type === 'error') { finish(new Error(data.message || 'Worker 内部错误')); return; }
                finish(null, data);
            };
            const onError = function (ev) { finish(new Error('Worker 出错：' + ((ev && ev.message) || '未知'))); };
            worker.addEventListener('message', onMessage);
            worker.addEventListener('error', onError);
            try {
                worker.postMessage(message, transfer || []);
            } catch (e) {
                finish(e);
            }
        });
    }

    /**
     * 关闭 Worker：必须先把 access handle close 掉再 terminate。
     * 实测（浏览器内）：不 close 直接 terminate 虽然数据仍在，但句柄要几秒后才释放，
     * 这期间重新打开同一个 .part 会报「another open Access Handle」—— 用户立刻点重试就会卡住。
     */
    async function dlCloseOpfsWorker(worker) {
        try { await dlWorkerRequest(worker, { type: 'close' }); } catch (ignored) { /* handle 可能已失效 */ }
        try { worker.terminate(); } catch (ignored) { /* 忽略 */ }
    }

    /** 打开 .part 文件；碰到句柄尚未释放时等待后重试一次 */
    async function dlOpenPart(worker, partName, offset, truncate, say) {
        const attempt = function () {
            return dlWorkerRequest(worker, { type: 'open', name: partName, offset: offset, truncate: truncate });
        };
        try {
            return await attempt();
        } catch (e) {
            const text = String((e && e.message) || '');
            if (/Access Handle|another open/i.test(text)) {
                if (typeof say === 'function') say('等待上一个下载句柄释放…', 'warn');
                await sleep(1500);
                return await attempt();
            }
            throw e;
        }
    }

    /** 断点记录：{ partName, offset, etag, total } —— 存 GM 存储，刷新页面也不丢 */
    function dlResumeLoad(key) {
        try {
            const raw = GM_getValue(DL_RESUME_PREFIX + key, '');
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    function dlResumeSave(key, record) {
        try { GM_setValue(DL_RESUME_PREFIX + key, JSON.stringify(record)); } catch (e) { /* 存不了不影响下载 */ }
    }

    function dlResumeClear(key) {
        try { GM_deleteValue(DL_RESUME_PREFIX + key); } catch (e) { /* 同上 */ }
    }

    /**
     * 从 Content-Range 里取总大小：bytes 100-199/1000 → 1000
     */
    function dlTotalFromContentRange(headerValue) {
        const match = /\/\s*(\d+)\s*$/.exec(String(headerValue || ''));
        return match ? Number(match[1]) : 0;
    }

    /**
     * 解析 Content-Range 的起始偏移：bytes 100-199/1000 → 100
     * 服务器给的起点和我们请求的不一致时，必须以服务器为准，否则会拼错文件。
     */
    function dlStartFromContentRange(headerValue) {
        const match = /bytes\s+(\d+)\s*-/i.exec(String(headerValue || ''));
        return match ? Number(match[1]) : -1;
    }

    /**
     * OPFS 断点续传下载。
     *
     * 返回 { fileName, totalBytes }；Worker 不可用 / 环境不支持时返回 null，调用方降级。
     * resumeKey 用 fileId，保证同一个文件多次尝试能接上，不同文件互不干扰。
     */
    async function dlDownloadViaOpfs(url, fileNameHint, resumeKey, onProgress, log) {
        const say = typeof log === 'function' ? log : function () {};
        const opfsRoot = await (async function () {
            try { return await navigator.storage.getDirectory(); } catch (e) { return null; }
        })();
        if (!opfsRoot) return null;

        const made = dlCreateOpfsWorker();
        if (!made) {
            say('此环境无法创建 Worker（可能被页面 CSP 拦截），改回直接写盘', 'warn');
            return null;
        }
        const worker = made.worker;
        let partName = '';
        let started = false;   // 是否已进入写入循环：之前失败可安全降级，之后失败必须保留断点并报错
        try {
            // 1) 读断点记录，决定从哪开始
            const record = dlResumeLoad(resumeKey);
            partName = (record && record.partName) || ('nme-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + DL_OPFS_PART_SUFFIX);
            let wantOffset = (record && record.offset > 0) ? record.offset : 0;

            // 上次已经下完、只是复制到目标目录没成功：不必再请求一次下载，直接交给调用方复制
            if (record && record.total > 0 && record.offset >= record.total && record.fileName) {
                say('上次已下载完成，直接写入目标目录', 'ok');
                return { fileName: record.fileName, totalBytes: record.offset, partName: partName };
            }

            // 2) 打开 OPFS 文件（wantOffset>0 时保留已有内容准备续写）
            const opened = await dlOpenPart(worker, partName, wantOffset, wantOffset <= 0, say);
            // OPFS 里实际大小可能比记录小（记录写过、flush 后崩在别处），以实际为准
            let offset = Math.min(wantOffset, opened.size || 0);
            if (offset !== wantOffset) {
                say('断点记录与实际不符，从 ' + offset + ' 字节继续', 'warn');
                const reopened = await dlOpenPart(worker, partName, offset, offset <= 0, say);
                offset = Math.min(offset, reopened.size || 0);
            }

            // 3) 发请求：有断点就带 Range
            //    挂上可中止信号：页面切后台时主动掐断，回前台再重入续传，避免以「网络错误」收场
            dlVisibilityController = new AbortController();
            const headers = {};
            if (offset > 0) headers['Range'] = 'bytes=' + offset + '-';
            const response = await dlFetchForDownload(url, {
                headers: headers,
                signal: dlVisibilityController.signal
            });
            if (!response.ok) throw new Error('HTTP ' + response.status);

            let finalName = dlResolveFinalFileName(response, fileNameHint);
            let total = 0;

            if (response.status === 206) {
                const contentRange = response.headers.get('content-range') || '';
                const serverStart = dlStartFromContentRange(contentRange);
                total = dlTotalFromContentRange(contentRange);
                if (!total) {
                    // 实测图片 CDN 未向脚本暴露 content-range（CORS），此时用「已下载 + 本次长度」推算，
                    // 否则完整性校验会失效
                    const segmentLength = Number(response.headers.get('content-length') || 0);
                    if (segmentLength) total = offset + segmentLength;
                }
                // 服务器起点与本地不一致：不能硬拼，直接重来
                if (serverStart >= 0 && serverStart !== offset) {
                    say('服务器续传起点与本地不一致，重新下载', 'warn');
                    offset = 0;
                    await dlOpenPart(worker, partName, 0, true, say);
                }
                const etag = response.headers.get('etag') || '';
                if (record && record.etag && etag && record.etag !== etag) {
                    say('文件已更新，之前的断点作废，重新下载', 'warn');
                    offset = 0;
                    await dlOpenPart(worker, partName, 0, true, say);
                }
            } else {
                // 200：服务器忽略 Range，只能从头写
                if (offset > 0) say('服务器未按断点返回，改为从头下载', 'warn');
                offset = 0;
                await dlWorkerRequest(worker, { type: 'open', name: partName, offset: 0, truncate: true });
                total = Number(response.headers.get('content-length') || 0);
            }

            if (offset > 0) say('从断点 ' + fmtSize(offset) + ' 继续下载', 'ok');
            started = true;

            // 4) 流式写入 OPFS（每块等到 Worker 回执，天然背压）
            if (!response.body || typeof response.body.getReader !== 'function') {
                const buffer = await response.arrayBuffer();
                if (buffer.byteLength > 0) {
                    await dlWorkerRequest(worker, { type: 'write', chunk: buffer }, [buffer]);
                    offset += buffer.byteLength;
                }
            } else {
                const reader = response.body.getReader();
                for (;;) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    const value = chunk.value;
                    const size = value.byteLength;
                    if (!size) continue;
                    // transferable：零拷贝移交，避免大块反复复制
                    await dlWorkerRequest(worker, { type: 'write', chunk: value }, [value.buffer]);
                    offset += size;
                    if (typeof onProgress === 'function') onProgress({ loaded: offset, total: total });
                    dlResumeSave(resumeKey, {
                        partName: partName, offset: offset, total: total, fileName: finalName
                    });
                }
            }

            const closed = await dlWorkerRequest(worker, { type: 'close' });
            const written = (closed && closed.offset) || offset;
            if (!written) throw new Error('下载内容为空（0 字节）');
            if (total && written !== total) {
                throw new Error('下载不完整（' + fmtSize(written) + ' / ' + fmtSize(total) + '），已保留断点，可重试');
            }

            return { fileName: finalName, totalBytes: written, partName: partName };
        } catch (err) {
            await dlCloseOpfsWorker(worker);
            // 切后台被我们主动中止：交给上层前台的守卫，回前台会重入续传，不要当成通道故障降级
            if (dlIsAbortError(err)) throw err;
            // 传输还没开始就失败（CSP / OPFS 配额 / Worker 初始化）→ 返回 null 让调用方降级；
            // 传输中途失败 → 抛出，OPFS 文件与断点记录都保留，用户重试即可续上。
            if (!started) {
                say('断点续传通道启用失败，改用直接写入：' + ((err && err.message) || err), 'warn');
                return null;
            }
            throw err;
        } finally {
            dlVisibilityController = null;
            try { worker.terminate(); } catch (ignored) { /* 已终止则忽略 */ }
            try { URL.revokeObjectURL(made.url); } catch (ignored) { /* 忽略 */ }
        }
    }

    /**
     * 把 OPFS 里的 .part 复制到目标目录，成功后删除临时文件。
     * 复制走 Blob.stream() → pipeTo(createWritable)，内存恒定，不会把整个文件读进来。
     */
    async function dlCommitOpfsToDir(dirHandle, partName, finalName) {
        const opfsRoot = await navigator.storage.getDirectory();
        const partHandle = await opfsRoot.getFileHandle(partName);
        const file = await partHandle.getFile();
        const targetHandle = await dirHandle.getFileHandle(finalName, { create: true });
        const writable = await targetHandle.createWritable();
        try {
            if (file.stream && typeof file.stream === 'function') {
                await file.stream().pipeTo(writable);
            } else {
                await writable.write(await file.arrayBuffer());
                await writable.close();
            }
        } catch (err) {
            try { await writable.abort(); } catch (ignored) { /* 忽略 */ }
            await dlRemoveEntry(dirHandle, finalName);
            throw err;
        }
        try { await opfsRoot.removeEntry(partName); } catch (ignored) { /* 删不掉不影响结果 */ }
        return finalName;
    }

    // ---------- 页面可见性：切后台优雅暂停 ----------
    //
    // 浏览器把后台页面冻结后，fetch 的响应回调无法继续执行，下载会以「网络错误」告终。
    // 与其让它自然断掉报错，不如自己先中止：断点本来就每块都存着，
    // 回到前台再重入一次就是从 offset 接着下，用户看不到失败。

    /** 主动中止当前下载请求（仅用于切后台场景） */
    function dlAbortCurrentFetch() {
        if (!dlVisibilityController) return;
        try { dlVisibilityController.abort(); } catch (ignored) { /* 已结束就忽略 */ }
    }

    /** 是否为「我们自己中止」造成的错误，用来把它和真正的网络错误区分开 */
    function dlIsAbortError(err) {
        if (!err) return false;
        if (err.name === 'AbortError') return true;
        return /abort/i.test(String(err.message || ''));
    }

    /** 等到页面重新可见；已经可见则立即返回 */
    function dlWaitVisible() {
        return new Promise(function (resolve) {
            if (!document.hidden) { resolve(true); return; }
            const onVisible = function () {
                if (document.hidden) return;
                document.removeEventListener('visibilitychange', onVisible);
                resolve(true);
            };
            document.addEventListener('visibilitychange', onVisible);
        });
    }

    /**
     * 在前台约束下执行下载动作。
     * fn 必须可安全重入（靠断点从 offset 继续），所以切后台中止后重试不会重复下载。
     */
    async function dlRunWithVisibilityGuard(fn, log) {
        const say = typeof log === 'function' ? log : function () {};
        for (let attempt = 0; attempt < 20; attempt++) {
            if (document.hidden) {
                say('已暂停：浏览器切到后台，回到前台会自动继续', 'warn');
                await dlWaitVisible();
                say('已回到前台，继续下载', 'ok');
            }
            try {
                return await fn();
            } catch (err) {
                if (!dlIsAbortError(err)) throw err;
                // 被切后台中止：等回到前台再重试，断点会让它接着下
                say('已暂停：浏览器切到后台，回到前台会自动继续', 'warn');
                await dlWaitVisible();
                say('已回到前台，继续下载', 'ok');
            }
        }
        throw new Error('反复切换前后台，下载未完成，请保持页面在前台');
    }

    /** 进度节流：大文件每读一块都改 DOM 会把页面拖卡 */
    function dlThrottledProgress(render) {
        let lastAt = 0;
        return function (progress) {
            const now = Date.now();
            if (now - lastAt < DL_PROGRESS_THROTTLE_MS) return;
            lastAt = now;
            render(progress);
        };
    }

    /**
     * 落一个文件到 <Mod名>/<文件名>：优先 FS 直写（路径可控），否则退回 GM_download 子目录。
     * 返回实际使用的通道，便于日志里说清楚「文件到底去了哪」。
     */
    async function archivePutFile(folder, fileName, url, options) {
        const opts = options || {};
        // 两个通道都先探一次真名：Nexus 的下载地址是 302 接口，直链末段没有真名，
        // 只有跟随重定向后才出现（形如 <标题>-<modId>-<fileId>-<版本>-<时间戳>.zip）。
        // 写盘函数拿到响应后还会再确认一次，这里探测只是让落盘名从一开始就正确。
        const probedName = await dlProbeFileName(url, fileName);
        if (opts.rootHandle) {
            const finalName = await dlSaveToRoot(
                opts.rootHandle, folder, probedName, url, opts.onProgress, opts.resumeKey, opts.log
            );
            return { channel: 'fs', fileName: finalName };
        }
        await gmDownloadTo(url, folder + '/' + probedName, {
            mode: 'start',
            onLateError: opts.onLateError
        });
        return { channel: 'gm', fileName: probedName };
    }

    /** 是否有任何能建目录的通道：File System Access 或 GM_download 子目录 */
    function dlHasArchiveChannel() {
        return !!(dlPickerApi() || dlHasDownloadApi());
    }

    /** 当前脚本管理器是否提供 GM_download（没声明 @grant 或管理器不支持时为 undefined） */
    function dlHasDownloadApi() {
        return typeof GM_download === 'function';
    }

    /**
     * 目录名清洗。
     * 除常规非法字符外，额外去掉开头的点和结尾的点/空格 —— Windows 不允许以点结尾的目录名，
     * 建目录会直接失败；超长则截断（mod 标题经常很长，整条路径会超系统限制）。
     */
    function sanitizeFolderName(raw, fallback) {
        let name = String(raw == null ? '' : raw)
            .replace(DL_FOLDER_BAD, '_')
            .replace(/\s+/g, ' ')
            .replace(/^[.\s]+|[.\s]+$/g, '');
        if (name.length > DL_FOLDER_MAX) {
            name = name.slice(0, DL_FOLDER_MAX).replace(/[.\s]+$/g, '');
        }
        return name || fallback || 'unknown-mod';
    }

    /** 文件名清洗：只换非法字符，截断时必须保住扩展名，否则文件打不开 */
    function sanitizeFileName(raw, fallback) {
        let name = String(raw == null ? '' : raw).replace(DL_FOLDER_BAD, '_').trim();
        if (name.length > DL_FILE_NAME_MAX) {
            const dot = name.lastIndexOf('.');
            const ext = dot > 0 ? name.slice(dot) : '';
            name = name.slice(0, DL_FILE_NAME_MAX - ext.length) + ext;
        }
        return name || fallback || 'file.zip';
    }

    /** 详情页 mod 标题：站点自己渲染的 h1 最可靠，不必额外打一次接口 */
    function pickModTitleFromDom() {
        const el = document.querySelector('#pagetitle h1') || document.querySelector('#pagetitle > h1');
        return el && el.textContent ? el.textContent.trim() : '';
    }

    /** 从直链里取末段文件名（解码 %20 之类，去掉查询串） */
    function fileNameFromUrl(url) {
        try {
            const parsed = new URL(url);
            const last = parsed.pathname.split('/').filter(Boolean).pop() || '';
            return decodeURIComponent(last);
        } catch (e) {
            return '';
        }
    }

    /**
     * 决定落盘文件名。
     * Nexus 的 file.name 经常没有扩展名（如 "Siris-FreeFin_Azure Drift_a little naughty"），
     * 直接当文件名会存成无后缀文件、双击打不开 —— 所以按「原名 → 直链末段 → mod 名+版本」三级兜底。
     */
    function pickDownloadFileName(file, url, modTitle, apiFileName) {
        // 优先级：接口给的真实文件名 → 文件标题 → 直链末段 → mod 名+版本兜底
        const fromApi = String(apiFileName || '').trim();
        const declared = String((file && file.name) || '').trim();
        const fromUrl = fileNameFromUrl(url);
        if (fromApi && DL_FILE_EXT.test(fromApi)) return fromApi;
        if (declared && DL_FILE_EXT.test(declared)) return declared;
        if (fromUrl && DL_FILE_EXT.test(fromUrl)) return fromUrl;
        // 兜底用 Nexus 的文件标题，不要用 mod 标题：
        // 同一 mod 下的多个文件用 mod 标题会撞名，且和站点上的实际文件名对不上。
        // 扩展名从直链末段借，借不到按 .zip 处理（Nexus 绝大多数 mod 文件是 zip）。
        const urlExt = (fromUrl.match(/\.([a-z0-9]{1,8})$/i) || [])[1];
        const base = sanitizeFolderName(declared || modTitle, 'file');
        return base + '.' + (urlExt || 'zip');
    }

    /**
     * 从当前页面 DOM 取真实文件名。
     *
     * Nexus 文件页把直链放在 data-download-url 上，末段就是站点自己的文件名
     * （<标题>-<modId>-<fileId>-<版本>-<时间戳>.zip）。
     * 这是唯一既不用拼装、也不用等重定向就能拿到的真名来源，优先用它。
     */
    function pickRealFileNameFromDom(fileId) {
        const nodes = document.querySelectorAll('[data-download-url]');
        let firstMatch = '';
        for (let i = 0; i < nodes.length; i++) {
            const url = decodeDlUrl(nodes[i].getAttribute('data-download-url') || '');
            const name = fileNameFromUrl(url);
            if (!name || !DL_FILE_EXT.test(name)) continue;
            if (!firstMatch) firstMatch = name;
            // 同一页可能有多个文件：按 fileId 命中，避免拿到别的文件的真名
            if (fileId && url.indexOf(String(fileId)) >= 0) return name;
        }
        return firstMatch;
    }

    /**
     * 详情页图库原图。
     * 站点把原图放在 li.thumb 的 data-src 上，img.src 是 thumbnails/ 下的缩略图 ——
     * 两者混用等于下回来一堆糊图，所以这里只认 data-src，并显式排掉 /thumbnails/ 路径。
     */
    function collectImagesFromDom() {
        const urls = [];
        const push = function (candidate) {
            const url = String(candidate || '').trim();
            if (!url || /^data:/i.test(url)) return;
            const pathOnly = url.split('?')[0];
            if (!DL_IMG_EXT.test(pathOnly)) return;
            if (/\/thumbnails\//i.test(pathOnly)) return;
            if (urls.indexOf(url) >= 0) return;
            urls.push(url);
        };
        const thumbs = document.querySelectorAll('ul.thumbgallery li.thumb[data-src], .thumbgallery .thumb[data-src]');
        for (let i = 0; i < thumbs.length; i++) push(thumbs[i].getAttribute('data-src'));
        return urls;
    }

    /**
     * 汇总要下载的图片：详情页图库原图 + GraphQL 封面（pictureUrl）。
     * 封面通常与图库第一张相同，push 里已去重；没有图库的 mod 只靠 pictureUrl 也能拿到主图。
     */
    function collectArchiveImages(opts) {
        const limit = Math.max(0, parseInt(CFG.dlImgLimit, 10) || 0);
        const urls = [];
        const push = function (candidate) {
            const url = String(candidate || '').trim();
            if (!url || /^data:/i.test(url)) return;
            if (!DL_IMG_EXT.test(url.split('?')[0])) return;
            if (urls.indexOf(url) >= 0) return;
            urls.push(url);
        };
        if (opts.ctxMode !== 'collection') {
            const dom = collectImagesFromDom();
            for (let i = 0; i < dom.length; i++) push(dom[i]);
        }
        push(opts.pictureUrl);
        return limit > 0 ? urls.slice(0, limit) : urls;
    }

    /**
     * 用 GM_download 把 url 落到 relPath（相对浏览器下载目录，含 / 会自动建子目录）。
     *
     * options.mode 决定语义（两种场景需求相反，不能一刀切）：
     *   'await'（默认）：等到 onload 才算成功 —— 单文件下载用，用户要看得到「下完了」。
     *   'start'        ：发起成功即返回，异步的 onerror 走 onLateError 上报 ——
     *                    合集批量下载用。几百 MB 的 mod 若逐个等完成，批量会慢到不可用；
     *                    浏览器的下载队列自己会排队，我们只需要保证「发起没被拒」。
     */
    function gmDownloadTo(url, relPath, options) {
        const opts = options || {};
        const mode = opts.mode === 'start' ? 'start' : 'await';
        return new Promise(function (resolve, reject) {
            if (!dlHasDownloadApi()) {
                reject(new Error('当前脚本管理器没有 GM_download，无法自动建文件夹'));
                return;
            }
            let settled = false;
            const settle = function (err) {
                if (settled) return;
                settled = true;
                if (err) reject(err); else resolve(true);
            };
            const reportLate = function (reason) {
                if (typeof opts.onLateError === 'function') opts.onLateError(reason);
            };
            try {
                GM_download({
                    url: url,
                    name: relPath,
                    // ScriptCat：'browser' 才是 URL 直传下载；默认 native 会整包读进内存
                    downloadMode: 'browser',
                    // 一旦弹「另存为」，用户选的路径会取代我们给的子目录，等于功能失效
                    saveAs: false,
                    // 同名自动加 (1)，不覆盖已下载的旧版本
                    conflictAction: 'uniquify',
                    onload: function () { settle(null); },
                    onerror: function (err) {
                        const reason = (err && (err.error || err.reason || err.message)) || '未知原因';
                        if (mode === 'start') {
                            reportLate(reason);
                            settle(null);
                            return;
                        }
                        settle(new Error('浏览器拒绝下载：' + reason));
                    },
                    ontimeout: function () {
                        if (mode === 'start') { reportLate('超时'); settle(null); return; }
                        settle(new Error('下载超时'));
                    },
                    onprogress: function (progress) {
                        if (typeof opts.onProgress === 'function') opts.onProgress(progress);
                    }
                });
                // 发起阶段没有抛错就认为已进入浏览器下载队列
                if (mode === 'start') settle(null);
            } catch (e) {
                settle(new Error((e && e.message) || String(e)));
            }
        });
    }

    /**
     * 归档下载主流程：解析直链 → 落 <Mod名>/<文件名> → 串行补图片。
     * opts: { domain, modId, fileId, gameId, fileName, version, modTitle, pictureUrl, ctxMode, log }
     * log(text, kind) 把每一步写进面板日志 —— 失败时用户能立刻看出断在哪一步，而不是「点了没反应」。
     */
    async function archiveDownload(opts) {
        const log = typeof opts.log === 'function' ? opts.log : function () {};
        const modTitle = opts.modTitle || '';
        // 多一层游戏名：<游戏名>/<Mod名>/，同一游戏的 mod 聚在一起
        const folder = archiveFolderPath(opts.gameName, modTitle || ('mod-' + (opts.modId || opts.fileId || 'unknown')));

        const resolved = await resolveWithRetry(opts.domain, opts.modId, opts.fileId, opts.gameId);
        const url = resolved.url;
        // 页面 DOM 里的直链末段就是站点自己的文件名，比任何接口字段与拼装都准
        const domFileName = pickRealFileNameFromDom(opts.fileId);
        const fileName = sanitizeFileName(
            pickDownloadFileName(
                { name: opts.fileName, version: opts.version },
                url,
                modTitle,
                domFileName || resolved.filename
            ),
            'file.zip'
        );
        const relPath = folder + '/' + fileName;

        log('保存到 ' + relPath, 'ok');
        // 进度节流：大文件每块都刷面板会把页面拖卡
        const progress = dlThrottledProgress(function (p) {
            log('下载中 ' + fmtSize(p.loaded) + (p.total ? ' / ' + fmtSize(p.total) : ''), 'busy');
        });
        const putOptions = {
            rootHandle: opts.rootHandle,
            // 断点续传按 fileId 记账：同一文件重试能接上，不同文件互不干扰
            resumeKey: opts.fileId ? ('file-' + opts.fileId) : '',
            onProgress: progress,
            log: log,
            onLateError: function (reason) { log('下载中断：' + fileName + ' — ' + reason, 'err'); }
        };
        // 文件系统通道由本页自己发请求，切后台会被冻结 → 用守卫优雅暂停并在回前台自动续；
        // 浏览器下载通道（GM_download）由浏览器进程管理，后台照常下，不需要守卫。
        const put = opts.rootHandle
            ? await dlRunWithVisibilityGuard(function () {
                return archivePutFile(folder, fileName, url, putOptions);
            }, log)
            : await archivePutFile(folder, fileName, url, putOptions);
        // put.fileName 才是真正落盘的名字（重定向后才拿到 CDN 真实文件名）
        const finalRelPath = folder + '/' + put.fileName;
        if (put.channel === 'fs') log('已写入所选目录：' + finalRelPath, 'ok');
        else log('⚠ 没走保存目录（' + (dlRootProblemText(opts.rootReason) || '未授权') +
            '），已退回浏览器下载，这条通道不保证建文件夹', 'warn');

        // 图片默认不跟着安装包走（见 DEFAULTS 注释）；独立按钮调用时用 forceImages 显式要求
        if (!opts.forceImages && !CFG.dlImagesWithMod) return { folder: folder, file: put.fileName, images: 0 };

        const images = collectArchiveImages(opts);
        if (!images.length) {
            log('该 mod 没有可下载的图片', 'warn');
            return { folder: folder, file: fileName, images: 0 };
        }

        let saved = 0;
        for (let i = 0; i < images.length; i++) {
            const imageUrl = images[i];
            const imageName = sanitizeFileName(
                fileNameFromUrl(imageUrl) || ('image-' + (i + 1) + '.png'),
                'image.png'
            );
            try {
                await archivePutFile(folder, imageName, imageUrl, { rootHandle: opts.rootHandle });
                saved++;
                log('图片 ' + (i + 1) + '/' + images.length + '：' + imageName, 'ok');
            } catch (e) {
                // 单张图失败不该影响已经下好的 mod，记一行日志继续
                log('图片跳过：' + imageName + ' — ' + ((e && e.message) || String(e)), 'err');
            }
            if (i < images.length - 1) await sleep(DL_IMG_GAP_MS);
        }
        return { folder: folder, file: put.fileName, images: saved };
    }

    /** 详情页归档所需的 mod 元信息：目录名、封面、版本（接口失败也不阻塞下载） */
    async function resolveArchiveMeta(ctx) {
        const domTitle = pickModTitleFromDom();
        let mod = null;
        try { mod = await ensureModDetail(ctx); } catch (e) { mod = null; }
        const title = domTitle || (mod && mod.name) || ('mod-' + ctx.modId);
        return {
            modTitle: sanitizeFolderName(title, 'mod-' + ctx.modId),
            // 游戏名优先取面包屑（站点展示名），接口返回兜底
            gameName: pickGameNameFromDom() || (mod && mod.game && mod.game.name) || '',
            pictureUrl: (mod && mod.pictureUrl) || '',
            version: (mod && mod.version) || ''
        };
    }

    /**
     * 下载当前 mod 的全部预览图到 <Mod名>/（独立按钮）。
     * 与「下载安装包时附带图片」的区别：这条路只下图片，不解析直链、不碰安装包，
     * 目录不存在时 GM_download 会按 name 里的路径自动建出来。
     */
    async function downloadModImages(ctx, btn) {
        if (!dlHasArchiveChannel()) {
            dlStatus('当前环境既没有 GM_download 也不支持 File System Access，无法自动建文件夹', 'err');
            return;
        }
        const old = btn.textContent;
        btn.disabled = true;
        btn.textContent = '获取中…';
        dlStatus('正在收集该 mod 的图片…', 'busy');
        try {
            const root = await dlEnsureRoot();
            if (!root.handle) {
                dlStatus('⚠ ' + dlRootProblemText(root.reason) + '，将退回浏览器下载（不保证建文件夹）', 'warn');
            }
            const meta = await resolveArchiveMeta(ctx);
            const folder = archiveFolderPath(meta.gameName, meta.modTitle);
            const images = collectArchiveImages({ ctxMode: 'detail', pictureUrl: meta.pictureUrl });
            if (!images.length) {
                dlStatus('该 mod 没有可下载的图片', 'warn');
                return;
            }
            dlStatus('开始下载 ' + images.length + ' 张图片到 ' + folder + '/ …', 'busy');
            let saved = 0;
            for (let i = 0; i < images.length; i++) {
                const imageUrl = images[i];
                const imageName = sanitizeFileName(
                    fileNameFromUrl(imageUrl) || ('image-' + (i + 1) + '.png'),
                    'image.png'
                );
                try {
                    await archivePutFile(folder, imageName, imageUrl, { rootHandle: root.handle });
                    saved++;
                    dlStatus('图片 ' + (i + 1) + '/' + images.length + '：' + imageName, 'ok');
                } catch (e) {
                    dlStatus('图片跳过：' + imageName + ' — ' + ((e && e.message) || String(e)), 'err');
                }
                if (i < images.length - 1) await sleep(DL_IMG_GAP_MS);
            }
            dlStatus('已下载 ' + saved + '/' + images.length + ' 张图片到 ' + folder + '/', 'ok');
        } catch (e) {
            dlStatus((e && e.message) || String(e), 'err');
        } finally {
            btn.disabled = false;
            btn.textContent = old;
        }
    }

    /**
     * 归档开关（详情页与合集页共用）。
     * 复选框直接读写 CFG；管理器没有 GM_download 时禁用并给出原因，
     * 避免用户以为「勾了就会建文件夹」结果什么都没发生。
     */
    function bindArchiveToggles(root, ctx) {
        if (!root) return;
        const supported = dlHasArchiveChannel();
        const folderBox = root.querySelector('#nme-dl-folder');
        const imagesBox = root.querySelector('#nme-dl-imgwith');
        if (folderBox) {
            folderBox.checked = !!CFG.dlFolder && supported;
            folderBox.disabled = !supported;
            if (folderBox.parentElement) {
                folderBox.parentElement.title = supported
                    ? '下载时自动创建 <Mod名> 文件夹，安装包与图片都放进去'
                    : '当前脚本管理器没有 GM_download（或脚本未声明 @grant GM_download），无法自动建文件夹';
            }
            folderBox.addEventListener('change', function () {
                CFG.dlFolder = folderBox.checked;
                saveCfg();
            });
        }
        if (imagesBox) {
            imagesBox.checked = !!CFG.dlImagesWithMod;
            imagesBox.disabled = !supported;
            if (imagesBox.parentElement) {
                imagesBox.parentElement.title = '勾选后，下载安装包时会顺带把预览图下到同一文件夹；' +
                    '不勾则改用旁边的「下载图片」按钮单独触发（默认不勾，避免每次下 mod 都额外请求一堆图）';
            }
            imagesBox.addEventListener('change', function () {
                CFG.dlImagesWithMod = imagesBox.checked;
                saveCfg();
            });
        }
        // 独立的「下载图片」按钮：只在详情页绑定（合集页没有单个 mod 的图库 DOM）
        const imageBtn = root.querySelector('#nme-dl-images-btn');
        if (imageBtn) {
            if (!ctx) {
                imageBtn.style.display = 'none';
            } else {
                imageBtn.disabled = !supported;
                imageBtn.addEventListener('click', function () { downloadModImages(ctx, imageBtn); });
            }
        }
        // 保存目录按钮：只有浏览器支持 File System Access 时才出现
        const rootBtn = root.querySelector('#nme-dl-root-btn');
        if (rootBtn) {
            if (!dlPickerApi()) {
                rootBtn.style.display = 'none';
            } else {
                rootBtn.addEventListener('click', async function () {
                    const handle = await chooseArchiveRoot();
                    if (handle) await refreshRootButtonLabel(rootBtn);
                });
                refreshRootButtonLabel(rootBtn);
            }
        }
    }

    // 归档自测用的固定图片：Nexus 静态 CDN，无需登录（实测 HTTP 200，211KB）
    const DL_SELFTEST_IMAGE = 'https://staticdelivery.nexusmods.com/mods/5577/images/868/868-1760599327-512078410.png';
    const DL_SELFTEST_FOLDER = 'NME自测';

    /**
     * 归档自测：把一张图下载到 <下载目录>/NME自测/self-test.png。
     *
     * 为什么需要这个入口：
     *   子目录能不能建出来不只取决于脚本 —— Chrome 若勾了「下载前询问每个文件的保存位置」，
     *   saveAs:false 会被该设置覆盖，用户选的路径会取代我们给的子目录；
     *   管理器版本差异也可能丢掉 downloadMode 字段（退回 native 的整包进内存）。
     *   与其下完几百 MB 才发现没建目录，不如先花 5 秒验证一次。
     */
    async function runArchiveSelfTest() {
        if (!dlHasArchiveChannel()) {
            showToast('自测失败', '当前环境既没有 GM_download 也不支持 File System Access，无法自动建文件夹', 'err');
            return;
        }
        const relPath = DL_SELFTEST_FOLDER + '/self-test.png';
        const root = await dlEnsureRoot();
        const usableRoot = root.handle;
        if (dlPickerApi() && !usableRoot) {
            showToast('请先选择保存目录',
                '你的浏览器支持文件系统通道，但还没选目录。先点面板上的「选择保存目录」——' +
                '只有这条通道能保证自动建文件夹，GM_download 通道建不建子目录取决于脚本管理器。', 'warn');
            return;
        }
        showToast('归档自测', '正在下载到 ' + relPath + ' …', 'busy');
        archivePutFile(DL_SELFTEST_FOLDER, 'self-test.png', DL_SELFTEST_IMAGE, { rootHandle: root.handle })
            .then(function (put) {
                const viaFs = put.channel === 'fs';
                showToast('自测成功（' + (viaFs ? '文件系统通道' : 'GM_download 通道') + '）',
                    '请确认' + (viaFs ? '所选保存目录' : '浏览器下载目录') + '下出现「' + relPath + '」。' +
                    (viaFs ? '' : '若文件落在根目录、名字里带下划线，说明管理器没把子目录传给浏览器 —— 请点「选择保存目录」改用文件系统通道。'),
                    'ok');
            })
            .catch(function (e) {
                showToast('自测失败', (e && e.message) || String(e), 'err');
            });
    }

    /** 保存目录按钮的文案：未选 / 已选可用 / 已选但授权过期 */
    async function refreshRootButtonLabel(btn) {
        if (!btn) return;
        let handle = null;
        try { handle = await dlLoadRootHandle(); } catch (e) { handle = null; }
        if (!handle) {
            btn.textContent = '① 选择保存目录（建文件夹必选）';
            btn.title = '选一次目录，之后下载自动在该目录下建 <Mod名> 文件夹。' +
                '不选则退回浏览器下载目录，那条通道是否建子目录取决于脚本管理器，不保证';
            return;
        }
        const granted = await dlPermissionGranted(handle);
        btn.textContent = granted ? ('保存到：' + handle.name) : ('重新授权：' + handle.name);
        btn.title = granted
            ? '下载会存到「' + handle.name + '/<Mod名>/」，点一下可更换目录'
            : '浏览器重启后目录授权会过期，点一下重新授权';
    }

    // ---------- 模组详情页：文件列表 + 一键下载 ----------

    function mountDetailDownload(ctx) {
        if (!ctx || ctx.mode !== 'detail' || $('#nme-dl-bar')) return;
        const sec = fabSection(FAB_SEC_DL);
        if (!sec) return;

        const bar = document.createElement('div');
        bar.id = 'nme-dl-bar';
        bar.innerHTML = [
            '<div class="nme-dl-head">',
            '  <span class="nme-dl-title">N网 下载</span>',
            '  <span class="nme-dl-sub">官方接口直链 · 个人文件下载</span>',
            '</div>',
            '<div class="nme-dl-actions">',
            '  <button id="nme-dl-refresh" class="nme-dl-btn" type="button">刷新文件列表</button>',
            '  <label class="nme-dl-opt"><input id="nme-dl-folder" type="checkbox"> 按 mod 建文件夹</label>',
            '  <label class="nme-dl-opt"><input id="nme-dl-imgwith" type="checkbox"> 下载时附带图片</label>',
            '  <button id="nme-dl-images-btn" class="nme-dl-btn" type="button">下载图片</button>',
            '  <button id="nme-dl-root-btn" class="nme-dl-btn" type="button">选择保存目录</button>',
            '  <span id="nme-dl-status" class="nme-ai-status"></span>',
            '</div>',
            '<div id="nme-dl-list" class="nme-dl-list"><div class="nme-dl-empty">正在读取文件列表…</div></div>'
        ].join('');

        sec.appendChild(bar);

        const refresh = bar.querySelector('#nme-dl-refresh');
        if (refresh) refresh.addEventListener('click', function () { loadDetailFiles(ctx); });
        const list = bar.querySelector('#nme-dl-list');
        if (list) {
            list.addEventListener('click', function (e) {
                const btn = e.target.closest('.nme-dl-go');
                if (!btn) return;
                const idx = parseInt(btn.getAttribute('data-idx'), 10);
                const f = state.dlFiles[idx];
                if (f) runSingleDownload(ctx, f, btn);
            });
        }
        bindArchiveToggles(bar, ctx);
        loadDetailFiles(ctx);
    }

    async function loadDetailFiles(ctx) {
        const list = $('#nme-dl-list');
        if (!list) return;
        list.innerHTML = '<div class="nme-dl-empty">正在读取文件列表…</div>';
        dlStatus('', '');
        try {
            const mod = await ensureModDetail(ctx);
            const gameId = mod.game && mod.game.id;
            if (!gameId) throw new Error('未取到 gameId');
            const d = await gqlRequest(Q_MOD_FILES, { modId: ctx.modId, gameId: gameId }, 'ModFiles');
            const files = (d && d.modFiles) || [];
            state.dlFiles = files;
            state.dlGameId = gameId;
            renderDetailFiles(files);
        } catch (e) {
            list.innerHTML = '<div class="nme-dl-empty nme-dl-err">' + escapeHtml((e && e.message) || String(e)) + '</div>';
        }
    }

    function renderDetailFiles(files) {
        const list = $('#nme-dl-list');
        if (!list) return;
        if (!files.length) {
            list.innerHTML = '<div class="nme-dl-empty">该模组还没有公开文件。</div>';
            return;
        }
        list.innerHTML = files.map(function (f, i) {
            const tag = f.category ? '<span class="nme-dl-tag">' + escapeHtml(f.category) + '</span>' : '';
            const meta = [
                f.version ? '版本 ' + f.version : '',
                f.sizeInBytes ? fmtSize(f.sizeInBytes) : '',
                f.totalDownloads != null ? '下载 ' + fmtNum(f.totalDownloads) : ''
            ].filter(Boolean).join(' · ');
            return '<div class="nme-dl-row">' +
                '<div class="nme-dl-main">' +
                '<div class="nme-dl-name">' + escapeHtml(f.name || ('文件 #' + f.fileId)) + tag + '</div>' +
                '<div class="nme-dl-meta">' + escapeHtml(meta) + '</div>' +
                '</div>' +
                '<button class="nme-dl-btn nme-dl-go" type="button" data-idx="' + i + '">一键下载</button>' +
                '</div>';
        }).join('');
    }

    async function runSingleDownload(ctx, file, btn) {
        if (dlTooSoon(file.fileId)) {
            dlStatus('刚刚已触发过该文件，请 30 秒后再试', 'warn');
            return;
        }
        const old = btn.textContent;
        btn.disabled = true;
        btn.textContent = '获取中…';
        dlStatus('正在获取「' + (file.name || file.fileId) + '」的下载地址…', 'busy');
        try {
            // 归档模式：<游戏名>/<Mod名>/，安装包与预览图都进去
            if (CFG.dlFolder && dlHasArchiveChannel()) {
                // 第一件事就是确认目录授权：用户激活窗口只有几秒，先等网络请求会把它耗掉
                const root = await dlEnsureRoot();
                if (!root.handle) {
                    dlStatus('⚠ ' + dlRootProblemText(root.reason) + '，将退回浏览器下载（不保证建文件夹）', 'warn');
                }
                const meta = await resolveArchiveMeta(ctx);
                const target = archiveFolderPath(meta.gameName, meta.modTitle);
                dlStatus('正在下载到 ' + target + '/ …', 'busy');
                const result = await archiveDownload({
                    domain: ctx.domain,
                    modId: ctx.modId,
                    fileId: file.fileId,
                    gameId: state.dlGameId,
                    fileName: file.name,
                    version: file.version || meta.version,
                    modTitle: meta.modTitle,
                    gameName: meta.gameName,
                    pictureUrl: meta.pictureUrl,
                    ctxMode: 'detail',
                    rootHandle: root.handle,
                    rootReason: root.reason,
                    log: function (text, kind) { dlStatus(text, kind); }
                });
                markDl(file.fileId);
                dlStatus('已加入下载：' + result.folder + '/' + result.file +
                    (result.images ? '（另 ' + result.images + ' 张图片）' : ''), 'ok');
                return;
            }
            // 未启用归档 / 管理器不支持 GM_download：保持 1.3.3 的单文件下载行为
            const resolved = await resolveWithRetry(ctx.domain, ctx.modId, file.fileId, state.dlGameId);
            triggerDownload(resolved.url, file.name);
            markDl(file.fileId);
            dlStatus('已开始下载：' + (file.name || file.fileId), 'ok');
        } catch (e) {
            dlStatus((e && e.message) || String(e), 'err');
        } finally {
            btn.disabled = false;
            btn.textContent = old;
        }
    }

    // ---------- 合集页：批量下载 ----------

    function dlHistoryLoad() {
        try { return JSON.parse(GM_getValue(DL_HISTORY_KEY, '{}') || '{}'); } catch (e) { return {}; }
    }

    function dlHistorySave(h) {
        try { GM_setValue(DL_HISTORY_KEY, JSON.stringify(h)); } catch (e) { /* 忽略 */ }
    }

    function dlHistoryKey(ctx) {
        return (ctx.domain || '') + '/' + (ctx.collectionSlug || '');
    }

    function dlLog(text, kind) {
        const box = $('#nme-dl-log');
        if (!box) return;
        const line = document.createElement('div');
        if (kind) line.className = 'nme-dl-log-' + kind;
        line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
        box.appendChild(line);
        while (box.children.length > DL_MAX_LOG) box.removeChild(box.firstChild);
        box.scrollTop = box.scrollHeight;
    }

    function mountCollectionDownload(ctx) {
        if (!ctx || ctx.mode !== 'collection' || $('#nme-dl-bar')) return;
        const sec = fabSection(FAB_SEC_DL);
        if (!sec) return;

        const bar = document.createElement('div');
        bar.id = 'nme-dl-bar';
        bar.innerHTML = [
            '<div class="nme-dl-head">',
            '  <span class="nme-dl-title">N网 合集下载</span>',
            '  <span id="nme-dl-sub" class="nme-dl-sub">正在读取合集…</span>',
            '</div>',
            '<div class="nme-dl-actions">',
            '  <label class="nme-dl-meta">间隔 <input id="nme-dl-gap" class="nme-dl-gap" type="number" min="1" max="60" step="1"></label>',
            '  <label class="nme-dl-opt"><input id="nme-dl-folder" type="checkbox"> 按 mod 建文件夹</label>',
            '  <label class="nme-dl-opt"><input id="nme-dl-imgwith" type="checkbox"> 下载时附带图片</label>',
            '  <button id="nme-dl-root-btn" class="nme-dl-btn" type="button">选择保存目录</button>',
            '  <button id="nme-dl-start" class="nme-dl-btn nme-dl-btn-accent" type="button" disabled>开始下载</button>',
            '  <button id="nme-dl-pause" class="nme-dl-btn" type="button" disabled>暂停</button>',
            '  <button id="nme-dl-stop" class="nme-dl-btn" type="button" disabled>停止</button>',
            '  <button id="nme-dl-clear" class="nme-dl-btn" type="button">清空历史</button>',
            '  <span id="nme-dl-status" class="nme-ai-status"></span>',
            '</div>',
            '<div class="nme-dl-prog"><div id="nme-dl-prog-fill" class="nme-dl-prog-fill"></div></div>',
            '<div id="nme-dl-log" class="nme-dl-log"></div>'
        ].join('');
        sec.appendChild(bar);

        const gapEl = bar.querySelector('#nme-dl-gap');
        gapEl.value = CFG.dlGap;
        gapEl.addEventListener('change', function () {
            const v = Math.max(1, Math.min(60, parseInt(gapEl.value, 10) || 5));
            CFG.dlGap = v;
            gapEl.value = v;
            saveCfg();
        });

        bar.querySelector('#nme-dl-start').addEventListener('click', function () { startCollectionDownload(ctx); });
        bar.querySelector('#nme-dl-pause').addEventListener('click', function () {
            state.dlPaused = !state.dlPaused;
            this.textContent = state.dlPaused ? '继续' : '暂停';
            dlStatus(state.dlPaused ? '已暂停' : '继续下载…', state.dlPaused ? 'warn' : 'busy');
        });
        bar.querySelector('#nme-dl-stop').addEventListener('click', function () {
            state.dlStop = true;
            dlStatus('正在停止…', 'warn');
        });
        bar.querySelector('#nme-dl-clear').addEventListener('click', function () {
            const h = dlHistoryLoad();
            delete h[dlHistoryKey(ctx)];
            dlHistorySave(h);
            dlLog('已清空本合集下载历史', 'ok');
        });

        bindArchiveToggles(bar);
        loadCollection(ctx);
    }

    async function loadCollection(ctx) {
        const sub = $('#nme-dl-sub');
        try {
            const d = await gqlRequest(Q_COLLECTION_MODS, {
                slug: ctx.collectionSlug,
                domain: ctx.domain || null
            }, 'CollectionRevisionMods');
            const rev = d && d.collectionRevision;
            if (!rev) throw new Error('未找到合集数据');
            const mods = (rev.modFiles || []).map(function (mf) {
                // 归档下载要用 mod 自己的名字建文件夹，所以这里必须保留 modName / pictureUrl，
                // 不能像 1.3.3 那样只取文件名 —— 否则合集里所有文件都会被塞进同一个目录。
                const modInfo = (mf.file && mf.file.mod) || {};
                const gameInfo = modInfo.game || {};
                return {
                    fileId: mf.fileId,
                    name: (mf.file && mf.file.name) || '',
                    sizeInBytes: mf.file && mf.file.sizeInBytes,
                    modId: modInfo.modId,
                    modName: modInfo.name || '',
                    pictureUrl: modInfo.pictureUrl || '',
                    domain: gameInfo.domainName || ctx.domain,
                    gameId: gameInfo.id,
                    gameName: gameInfo.name || '',
                    optional: !!mf.optional
                };
            }).filter(function (m) { return m.fileId && m.modId && m.gameId; });

            state.dlQueue = mods;
            state.dlTotal = mods.length;
            const mandatory = mods.filter(function (m) { return !m.optional; }).length;
            if (sub) sub.textContent = mods.length + ' 个文件（必装 ' + mandatory + ' / 可选 ' + (mods.length - mandatory) + '）';
            const start = $('#nme-dl-start');
            if (start) start.disabled = mods.length === 0;
            dlLog('已读取合集：' + mods.length + ' 个文件');
        } catch (e) {
            if (sub) sub.textContent = '读取合集失败';
            dlStatus((e && e.message) || String(e), 'err');
        }
    }

    function setDlProgress(done, total) {
        const fill = $('#nme-dl-prog-fill');
        if (fill) fill.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    }

    function setDlButtons(running) {
        const start = $('#nme-dl-start');
        const pause = $('#nme-dl-pause');
        const stop = $('#nme-dl-stop');
        if (start) { start.disabled = running; start.textContent = running ? '下载中…' : '开始下载'; }
        if (pause) { pause.disabled = !running; pause.textContent = '暂停'; }
        if (stop) stop.disabled = !running;
    }

    async function startCollectionDownload(ctx) {
        openFab(FAB_SEC_DL);
        if (state.dlRunning) return;
        if (!state.dlQueue.length) { await loadCollection(ctx); }
        const queue = state.dlQueue || [];
        if (!queue.length) { dlStatus('合集里没有可下载的文件', 'err'); return; }

        if (!isLoggedIn()) { dlStatus('请先登录 Nexus Mods 账号', 'err'); return; }

        const ok = window.confirm(
            '即将逐个请求下载合集里的 ' + queue.length + ' 个文件。\n\n' +
            '· 会在当前页连续触发浏览器下载，出现「允许下载多个文件」时请允许；\n' +
            '· 免费账号会走慢速通道，间隔太短容易触发站点限流；\n' +
            '· 批量下载可能不符合 Nexus 的使用条款，请自行判断。\n\n' +
            '继续？'
        );
        if (!ok) return;

        // 目录授权：confirm 的「确定」同样是一次用户激活，趁激活窗口还在先确认
        if (CFG.dlFolder && dlHasArchiveChannel()) {
            const root = await dlEnsureRoot();
            state.dlRootHandle = root.handle;
            state.dlRootReason = root.reason;
            if (!root.handle) {
                dlLog('⚠ ' + dlRootProblemText(root.reason) + '，将退回浏览器下载（不保证建文件夹）', 'warn');
            }
        }

        const history = dlHistoryLoad();
        const key = dlHistoryKey(ctx);
        if ((history[key] || []).length) {
            const skip = window.confirm('历史里已有 ' + history[key].length + ' 个已下载文件。\n\n确定 = 跳过它们，只下缺的；取消 = 重新下载全部。');
            if (!skip) { history[key] = []; dlHistorySave(history); }
        }
        const done = history[key] || [];

        state.dlRunning = true;
        state.dlStop = false;
        state.dlPaused = false;
        state.dlDone = 0;
        state.dlCount = 0;
        let fails = 0;
        setDlButtons(true);
        dlStatus('开始下载…', 'busy');
        setDlProgress(0, queue.length);
        dlLog('开始下载，共 ' + queue.length + ' 个文件');

        for (let i = 0; i < queue.length; i++) {
            if (state.dlStop) break;
            while (state.dlPaused && !state.dlStop) await sleep(500);
            if (state.dlStop) break;

            const f = queue[i];
            if (done.indexOf(f.fileId) >= 0) {
                dlLog('[' + (i + 1) + '/' + queue.length + '] 跳过（历史已下载）：' + f.name);
                state.dlDone++;
                setDlProgress(state.dlDone, queue.length);
                continue;
            }
            if (dlTooSoon(f.fileId)) {
                dlLog('[' + (i + 1) + '/' + queue.length + '] 跳过（刚刚已手动触发）：' + f.name);
                state.dlDone++;
                setDlProgress(state.dlDone, queue.length);
                continue;
            }

            if (state.dlCount >= DL_RATE_LIMIT) {
                dlLog('已连续下载 ' + DL_RATE_LIMIT + ' 个，冷却 ' + DL_COOLDOWN + ' 秒…', 'warn');
                let left = DL_COOLDOWN;
                while (left > 0 && !state.dlStop) {
                    dlStatus('安全冷却中，剩余 ' + left + ' 秒', 'warn');
                    await sleep(1000);
                    left--;
                }
                state.dlCount = 0;
            }
            if (state.dlStop) break;

            dlStatus('[' + (i + 1) + '/' + queue.length + '] 正在获取：' + f.name, 'busy');
            try {
                if (CFG.dlFolder && dlHasArchiveChannel()) {
                    const result = await archiveDownload({
                        domain: f.domain,
                        modId: f.modId,
                        fileId: f.fileId,
                        gameId: f.gameId,
                        fileName: f.name,
                        modTitle: f.modName,
                        gameName: f.gameName,
                        pictureUrl: f.pictureUrl,
                        ctxMode: 'collection',
                        rootHandle: state.dlRootHandle,
                        rootReason: state.dlRootReason,
                        log: function (text, kind) { dlLog('    ' + text, kind); }
                    });
                    markDl(f.fileId);
                    done.push(f.fileId);
                    history[key] = done;
                    dlHistorySave(history);
                    state.dlCount++;
                    state.dlDone++;
                    fails = 0;
                    dlLog('[' + (i + 1) + '/' + queue.length + '] 已保存到 ' + result.folder + '/' + result.file +
                        (result.images ? '（+' + result.images + ' 图）' : ''), 'ok');
                } else {
                    const resolved = await resolveWithRetry(f.domain, f.modId, f.fileId, f.gameId);
                    triggerDownload(resolved.url, f.name);
                    markDl(f.fileId);
                    done.push(f.fileId);
                    history[key] = done;
                    dlHistorySave(history);
                    state.dlCount++;
                    state.dlDone++;
                    fails = 0;
                    dlLog('[' + (i + 1) + '/' + queue.length + '] 已开始下载：' + f.name, 'ok');
                }
            } catch (e) {
                const msg = (e && e.message) || String(e);
                const fatal = !!(e && e.fatal);
                fails++;
                dlLog('[' + (i + 1) + '/' + queue.length + '] 失败：' + f.name + ' — ' + msg, 'err');
                dlStatus(msg, 'err');
                if (fatal || fails >= 3) {
                    dlLog(fatal ? '遇到「' + msg + '」，已停止批量下载' : '连续 3 个文件失败，已停止批量下载', 'err');
                    state.dlStop = true;
                    break;
                }
            }
            setDlProgress(state.dlDone, queue.length);

            if (i < queue.length - 1 && !state.dlStop) {
                const gap = Math.max(1, CFG.dlGap || 5) * 1000;
                await sleep(gap);
            }
        }

        state.dlRunning = false;
        state.dlPaused = false;
        setDlButtons(false);
        if (state.dlStop) dlStatus('已停止（已下载的会记入历史）', 'warn');
        else dlStatus('批量下载结束：' + state.dlDone + ' / ' + queue.length + '（含历史跳过）', 'ok');
        setDlProgress(state.dlDone, queue.length);
    }

    // ---------- 下载等待页自动跳过 ----------

    function setupDownloadSkip() {
        if (!CFG.skipWait) return;
        const isWaitPage =
            /\/Core\/Libs\/Common\/Widgets\/DownloadPopUp/i.test(location.pathname + location.search) ||
            (/[?&]file_id=\d+/i.test(location.search) && /[?&]nmm=1/i.test(location.search));
        if (!isWaitPage) return;

        const guard = 'nme.skip.' + location.href;
        try { if (sessionStorage.getItem(guard)) return; } catch (e) { /* 忽略 */ }

        let tries = 0;
        const tick = function () {
            const btn = document.querySelector('#slowDownloadButton[data-download-url], [data-download-url]');
            const url = btn && decodeDlUrl(btn.getAttribute('data-download-url') || '');
            if (url && /^(https?:|nxm:)/i.test(url)) {
                try { sessionStorage.setItem(guard, '1'); } catch (e) { /* 忽略 */ }
                location.href = url;
                return;
            }
            tries++;
            if (tries < 120) setTimeout(tick, 250);
        };
        tick();
    }

    // ==================== 列表页：AI 解读当前页 ====================

    function renderPageDigest(data) {
        const groups = (data.groups || []).map(function (g) {
            const picks = (g.picks || []).map(function (p) {
                const name = escapeHtml(p.name || ('#' + p.id));
                const id = parseInt(p.id, 10);
                const dom = state.ctx && state.ctx.domain;
                const title = (dom && id > 0)
                    ? '<a href="https://www.nexusmods.com/games/' + encodeURIComponent(dom) + '/mods/' + id + '">' + name + '</a>'
                    : name;
                return '<li>' + title + '<span class="nme-ai-why">' + escapeHtml(p.why || '') + '</span></li>';
            }).join('');
            return '<div class="nme-ai-sec-title">' + escapeHtml(g.theme || '推荐') + '</div><ul class="nme-ai-list">' + picks + '</ul>';
        }).join('');
        return '<div class="nme-ai-card">' +
            '<div class="nme-ai-card-head">AI 解读本页</div>' +
            (groups || '<div class="nme-ai-text">AI 没有给出推荐。</div>') +
            (data.tip ? '<div class="nme-ai-sec-title">提示</div><div class="nme-ai-text">' + escapeHtml(data.tip) + '</div>' : '') +
            '</div>';
    }

    async function runPageDigest() {
        const btn = $('#nme-ai-digest');
        const out = $('#nme-ai-digest-out');
        if (!out) return;
        if (!aiConfigured()) { openAiSettings(); return; }
        if (!state.mods || !state.mods.length) {
            out.hidden = false;
            out.innerHTML = '<div class="nme-ai-card nme-ai-text">当前还没有加载到模组，先滚动加载一些再试。</div>';
            return;
        }
        const mods = state.mods.slice(0, 60);
        const fingerprint = 'pg.' + normKey(state.ctx.domain || '') + '.' + mods.map(function (m) { return m.modId; }).join('-');
        const cached = aiCacheGet(fingerprint);
        if (cached) {
            out.hidden = false;
            out.innerHTML = renderPageDigest(cached.v);
            return;
        }
        if (btn) btn.disabled = true;
        out.hidden = false;
        out.innerHTML = '<div class="nme-ai-card nme-ai-text">AI 正在解读本页 ' + mods.length + ' 个模组…</div>';
        try {
            const lines = mods.map(function (m) {
                return m.modId + ' | ' + (m.name || '') + ' | ' + (m.summary || '').slice(0, 90) +
                    ' | 下载 ' + (m.downloads || 0) + ' | 点赞 ' + (m.endorsements || 0) +
                    ' | ' + (m.modCategory && m.modCategory.name || '');
            }).join('\n');
            const prompt = '下面是 Nexus Mods 一个游戏模组列表页当前加载的模组（格式：id | 名称 | 简介 | 下载 | 点赞 | 分类）。\n' +
                '请从中挑选最值得安装的 5-8 个，并按用途分组。输出 JSON（只输出 JSON，不要 markdown 代码块）：\n' +
                '{"groups":[{"theme":"分组名","picks":[{"id":123,"name":"模组名","why":"一句话推荐理由"}]}],"tip":"一句总体建议"}\n\n' +
                '只从给定列表里选，id 必须原样保留。列表：\n' + lines;
            const text = await callAi(prompt, { temperature: 0.3, maxTokens: 1600 });
            const data = parseAiJson(text);
            aiCacheSet(fingerprint, data);
            out.innerHTML = renderPageDigest(data);
        } catch (e) {
            out.innerHTML = '<div class="nme-ai-card nme-ai-status-err">' + escapeHtml((e && e.message) || String(e)) + '</div>';
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ==================== 中文找游戏：工具条交互 ====================

    function setCnMsg(text, kind) {
        const el = $('#nme-cn-msg');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'nme-cn-msg' + (kind ? ' nme-cn-msg-' + kind : '');
    }

    function renderGameResults(list) {
        const box = $('#nme-cn-results');
        if (!box) return;
        box.hidden = false;
        if (!list || !list.length) {
            box.innerHTML = '<div class="nme-cn-empty">没有匹配到游戏。可以试试英文名或 Nexus 游戏域名（如 <code>stellarblade</code>）。</div>';
            return;
        }
        box.innerHTML = list.map(function (g) {
            const href = 'https://www.nexusmods.com/games/' + encodeURIComponent(g.domain) + '/mods';
            const count = g.modCount == null ? '' : '<span class="nme-cn-count">' + fmtNum(g.modCount) + ' 个模组</span>';
            return '<a class="nme-cn-item" href="' + href + '">' +
                '<span class="nme-cn-name">' + escapeHtml(g.name) + '</span>' +
                '<span class="nme-cn-domain">' + escapeHtml(g.domain) + '</span>' +
                count +
                '<span class="nme-cn-src">' + escapeHtml(g.source || '') + '</span>' +
                '</a>';
        }).join('');
    }

    async function runCnGameSearch() {
        const input = $('#nme-cn');
        const btn = $('#nme-cn-go');
        const term = (input && input.value || '').trim();
        if (!term) return;
        if (btn) btn.disabled = true;
        setCnMsg('正在解析「' + term + '」…', 'busy');
        const box = $('#nme-cn-results');
        if (box) { box.hidden = false; box.innerHTML = ''; }
        try {
            const list = await resolveGame(term);
            renderGameResults(list);
            if (!list.length) setCnMsg('未找到对应游戏', 'warn');
            else setCnMsg('找到 ' + list.length + ' 个候选，点选进入游戏模组页', 'ok');
        } catch (e) {
            setCnMsg((e && e.message) || String(e), 'err');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ==================== 页面上下文 ====================

    /**
     * 解析当前页面属于哪类列表页，以及 URL 上已有的筛选条件。
     * 只认站点自己已经在用的 URL 参数，不臆造参数名。
     */
    function getContext() {
        const u = new URL(location.href);
        const path = u.pathname;
        let mode = null, domain = null, modId = 0, collectionSlug = null;

        const mGame = path.match(/^\/games\/([^/]+)\/mods\/?$/);
        const mLegacy = path.match(/^\/([^/]+)\/mods\/?$/);
        const mDetail = path.match(/^\/games\/([^/]+)\/mods\/(\d+)/) || path.match(/^\/([^/]+)\/mods\/(\d+)/);
        const mColl = path.match(/^\/games\/([^/]+)\/collections\/([^/?#]+)/) || path.match(/^\/([^/]+)\/collections\/([^/?#]+)/);
        if (mDetail) { mode = 'detail'; domain = mDetail[1]; modId = parseInt(mDetail[2], 10) || 0; }
        else if (mColl) { mode = 'collection'; domain = mColl[1]; collectionSlug = mColl[2]; }
        else if (mGame) { mode = 'list'; domain = mGame[1]; }
        else if (mLegacy) { mode = 'list'; domain = mLegacy[1]; }
        else if (/^\/search\/?$/.test(path) || path.indexOf('/search') === 0) {
            mode = 'search';
        }
        if (!mode) return null;

        const sp = u.searchParams;
        const categoryName = sp.getAll('categoryName').filter(Boolean);
        const tagNames = sp.getAll('tag').filter(Boolean);
        const languageName = sp.getAll('languageName').filter(Boolean);
        const keyword = sp.get('keyword') || '';

        return {
            mode: mode,
            domain: domain,
            modId: modId,
            collectionSlug: collectionSlug,
            keyword: keyword,
            categoryName: categoryName,
            tags: tagNames,
            languageName: languageName,
            page: parseInt(sp.get('page') || '1', 10) || 1
        };
    }

    // ==================== 增强视图 ====================

    const SORTS = [
        ['createdAt', '发布日期'],
        ['updatedAt', '最近更新'],
        ['downloads', '下载量'],
        ['uniqueDownloads', '独立下载量'],
        ['endorsements', '点赞数'],
        ['name', '模组名称'],
        ['size', '文件大小'],
        ['lastComment', '最近评论'],
        ['random', '随机惊喜']
    ];

    const PAGE_SIZES = [20, 40, 60, 80];
    const SORT_KEYS = SORTS.map(function (s) { return s[0]; });

    function normChips(c) {
        c = (c && typeof c === 'object') ? c : {};
        return { zh: !!c.zh, zht: !!c.zht, tr: !!c.tr, hot: !!c.hot };
    }

    /** 修正旧版本或手改过的配置，避免把非法参数发给 GraphQL */
    function sanitizeCfg() {
        const size = Number(CFG.pageSize);
        CFG.pageSize = PAGE_SIZES.indexOf(size) >= 0 ? size : DEFAULTS.pageSize;
        if (CFG.view !== 'native' && CFG.view !== 'enhanced') CFG.view = DEFAULTS.view;
        if (SORT_KEYS.indexOf(CFG.sortBy) < 0) CFG.sortBy = DEFAULTS.sortBy;
        if (CFG.sortDir !== 'ASC' && CFG.sortDir !== 'DESC') CFG.sortDir = DEFAULTS.sortDir;
        CFG.minDownloads = Math.max(0, parseInt(CFG.minDownloads, 10) || 0);
        CFG.minEndorsements = Math.max(0, parseInt(CFG.minEndorsements, 10) || 0);
        CFG.maxSizeMB = Math.max(0, parseFloat(CFG.maxSizeMB) || 0);
        CFG.dlGap = Math.min(60, Math.max(1, parseInt(CFG.dlGap, 10) || DEFAULTS.dlGap));
        CFG.keyword = String(CFG.keyword || '');
        CFG.zhUI = !!CFG.zhUI;
        CFG.badges = !!CFG.badges;
        CFG.skipWait = !!CFG.skipWait;
        // 归档下载三项：类型与范围就地纠正，避免手改 GM 存储后出现字符串/越界值
        CFG.dlFolder = !!CFG.dlFolder;
        CFG.dlImagesWithMod = !!CFG.dlImagesWithMod;
        CFG.dlImgLimit = Math.min(50, Math.max(0, parseInt(CFG.dlImgLimit, 10) || 0));
        CFG.chips = normChips(CFG.chips);
        state.chips = normChips(CFG.chips);
        saveCfg();
    }

    const state = {
        ctx: null,
        offset: 0,
        total: 0,
        loaded: 0,
        loading: false,
        done: false,
        error: '',
        retried: false,
        chips: normChips(CFG.chips),
        tpl: null,
        mods: [],
        modCache: null,
        modLoading: null,
        io: null,
        // 下载增强
        dlFiles: [],
        dlGameId: 0,
        dlQueue: [],
        dlTotal: 0,
        dlRunning: false,
        dlPaused: false,
        dlStop: false,
        dlDone: 0,
        dlCount: 0,
        // 下载历史
        histOnly: false,
        // React 水合：站点是否走 React、是否已提交、容器在哪
        reactApp: false,
        reactSeen: false,
        hydrated: false,
        reactContainer: null
    };

    function buildVariables(offset) {
        const ctx = state.ctx;
        const chips = state.chips;

        const facets = {
            categoryName: ctx.categoryName.slice(),
            languageName: ctx.languageName.slice(),
            tag: ctx.tags.slice()
        };

        if (chips.zh && facets.languageName.indexOf('Simplified Chinese') < 0) {
            facets.languageName.push('Simplified Chinese');
        }
        if (chips.zht && facets.languageName.indexOf('Traditional Chinese') < 0) {
            facets.languageName.push('Traditional Chinese');
        }
        if (chips.tr && facets.tag.indexOf('Translation') < 0) {
            facets.tag.push('Translation');
        }

        const filter = {
            adultContent: [{ op: 'EQUALS', value: false }],
            filter: [],
            gameDomainName: ctx.mode === 'list' ? [{ op: 'EQUALS', value: ctx.domain }] : [],
            name: [],
            op: 'AND'
        };

        const kw = (CFG.keyword || '').trim() || ctx.keyword;
        if (kw) {
            // 名称（WILDCARD）与描述（MATCHES）取并集，再与其它条件 AND 组合
            filter.filter = [{
                op: 'OR',
                filter: [
                    { name: [{ op: 'WILDCARD', value: kw }] },
                    { description: [{ op: 'MATCHES', value: kw }] }
                ]
            }];
        }
        if (ctx.mode === 'search') filter.status = [{ op: 'EQUALS', value: 'published' }];

        const minDl = state.chips.hot ? Math.max(CFG.minDownloads || 0, 1000) : (CFG.minDownloads || 0);
        if (minDl > 0) filter.downloads = [{ op: 'GTE', value: minDl }];
        if (CFG.minEndorsements > 0) filter.endorsements = [{ op: 'GTE', value: CFG.minEndorsements }];
        if (CFG.maxSizeMB > 0) filter.fileSize = [{ op: 'LTE', value: Math.round(CFG.maxSizeMB * 1024 * 1024) }];

        const sort = {};
        sort[CFG.sortBy] = { direction: CFG.sortDir };

        return {
            count: CFG.pageSize,
            offset: offset,
            facets: facets,
            filter: filter,
            postFilter: {},
            sort: sort
        };
    }

    function makeTile(mod) {
        const tpl = state.tpl;
        const tile = tpl.cloneNode(true);

        // 去掉原生菜单按钮（headlessui 依赖 React，克隆后无功能且 id 重复）
        const menuBtn = tile.querySelector('button[aria-label="Mod options"]');
        if (menuBtn && menuBtn.parentElement) menuBtn.parentElement.removeChild(menuBtn);

        // 模板可能已经被原生视图的徽章逻辑装饰过，克隆后要先清掉，避免徽章重复
        $$('.nme-badges', tile).forEach(function (h) { h.remove(); });
        tile.removeAttribute('data-nme-badged');

        const setText = (sel, text) => {
            const el = tile.querySelector(sel);
            if (el) el.textContent = text;
            return el;
        };

        // 缩略图
        const thumbLink = tile.querySelector('a[href*="/mods/"]');
        const thumbImg = tile.querySelector('img');
        if (thumbLink) thumbLink.setAttribute('href', 'https://www.nexusmods.com/' + (mod.game && mod.game.domainName ? mod.game.domainName : '') + '/mods/' + mod.modId);
        if (thumbImg) {
            if (mod.thumbnailUrl) thumbImg.setAttribute('src', mod.thumbnailUrl);
            thumbImg.setAttribute('alt', mod.name || '');
        }

        // 标题
        const title = tile.querySelector('[data-e2eid="mod-tile-title"]');
        if (title) {
            title.textContent = mod.name || '';
            title.setAttribute('href', 'https://www.nexusmods.com/' + (mod.game && mod.game.domainName ? mod.game.domainName : '') + '/mods/' + mod.modId);
        }

        // 上传者
        const userLink = tile.querySelector('[data-e2eid="user-link"]');
        if (userLink) {
            const uname = (mod.uploader && mod.uploader.name) || '—';
            userLink.setAttribute('href', 'https://www.nexusmods.com/profile/' + encodeURIComponent(uname));
            const span = userLink.querySelector('span');
            if (span) span.textContent = uname;
            const avatar = userLink.querySelector('img[data-testid="user-link-avatar"]');
            if (avatar && mod.uploader && mod.uploader.avatar) avatar.setAttribute('src', mod.uploader.avatar);
        }

        // 分类
        const cat = tile.querySelector('[data-e2eid="mod-tile-category"]');
        if (cat) {
            const cname = (mod.modCategory && mod.modCategory.name) || '';
            cat.textContent = cname;
            if (cname && mod.game && mod.game.domainName) {
                cat.setAttribute('href', 'https://www.nexusmods.com/games/' + mod.game.domainName + '/mods?categoryName=' + encodeURIComponent(cname));
            }
        }

        // 时间
        const upd = tile.querySelector('[data-e2eid="mod-tile-updated"] time');
        if (upd) { upd.textContent = fmtRelative(mod.updatedAt); upd.setAttribute('datetime', mod.updatedAt || ''); }
        const upl = tile.querySelector('[data-e2eid="mod-tile-uploaded"] time');
        if (upl) { upl.textContent = fmtDate(mod.createdAt); upl.setAttribute('datetime', mod.createdAt || ''); }

        // 摘要
        const sum = tile.querySelector('[data-e2eid="mod-tile-summary"]');
        if (sum) sum.textContent = mod.summary || '';

        // 数值
        setText('[data-e2eid="mod-tile-endorsements"]', fmtNum(mod.endorsements));
        setText('[data-e2eid="mod-tile-downloads"]', fmtNum(mod.downloads));
        setText('[data-e2eid="mod-tile-file-size"]', fmtSize(mod.fileSize));

        // 语言徽章
        const badges = detectBadges(mod);
        if (badges.length && title && title.parentElement) {
            const holder = document.createElement('span');
            holder.className = 'nme-badges';
            for (let i = 0; i < badges.length; i++) {
                const b = document.createElement('span');
                b.className = 'nme-badge ' + badges[i].cls;
                b.textContent = badges[i].text;
                holder.appendChild(b);
            }
            title.parentElement.insertBefore(holder, title.nextSibling);
        }

        return tile;
    }

    function renderStatus() {
        const status = $('#nme-status');
        const msg = $('#nme-msg');
        const total = $('#nme-total');
        const loaded = $('#nme-loaded');
        if (!status) return;
        if (total) total.textContent = state.total ? fmtNum(state.total) : '—';
        if (loaded) loaded.textContent = fmtNum(state.loaded);

        if (state.error) {
            status.className = 'nme-status nme-status-err';
            if (msg) {
                msg.textContent = '';
                msg.appendChild(document.createTextNode('加载失败：' + state.error + ' '));
                const retry = document.createElement('button');
                retry.className = 'nme-btn';
                retry.type = 'button';
                retry.textContent = '重试';
                retry.addEventListener('click', function () {
                    state.retried = false;
                    loadPage(true);
                });
                msg.appendChild(retry);
            }
        } else if (state.done) {
            status.className = 'nme-status';
            if (msg) msg.textContent = '已全部加载。';
        } else if (state.loading) {
            status.className = 'nme-status';
            if (msg) msg.textContent = '加载中…';
        } else {
            status.className = 'nme-status';
            if (msg) msg.textContent = '继续滚动加载更多。';
        }
    }

    async function loadPage(reset) {
        if (state.loading) return;
        if (reset) {
            state.offset = 0;
            state.loaded = 0;
            state.total = 0;
            state.mods = [];
            state.done = false;
            state.error = '';
            state.retried = false;
            const grid = $('#nme-grid');
            if (grid) grid.innerHTML = '';
        }
        if (state.done) return;

        state.loading = true;
        renderStatus();

        try {
            const data = await queryMods(buildVariables(state.offset));
            state.error = '';
            state.total = data.totalCount || 0;
            const nodes = data.nodes || [];
            const grid = $('#nme-grid');
            if (grid) {
                const frag = document.createDocumentFragment();
                for (let i = 0; i < nodes.length; i++) frag.appendChild(makeTile(nodes[i]));
                grid.appendChild(frag);
            }
            state.loaded += nodes.length;
            state.offset += nodes.length;
            for (let i = 0; i < nodes.length; i++) state.mods.push(nodes[i]);
            if (nodes.length === 0 || state.offset >= state.total) state.done = true;
        } catch (e) {
            state.error = (e && e.message) || String(e);
            // 站点偶发限流/断连（实测批量请求后会出现 Failed to fetch），自动重试一次
            if (!state.retried) {
                state.retried = true;
                setTimeout(function () { loadPage(false); }, 1500);
                return; // finally 会统一收尾
            }
        } finally {
            state.loading = false;
            renderStatus();
        }
    }

    // ==================== 工具条 ====================

    function buildPanel(ctx) {
        const panel = document.createElement('div');
        panel.id = 'nme-panel';

        const sortOptions = SORTS.map(function (s) {
            return '<option value="' + s[0] + '"' + (s[0] === CFG.sortBy ? ' selected' : '') + '>' + s[1] + '</option>';
        }).join('');

        panel.innerHTML = [
            '<div id="nme-toolbar">',
            '<div class="nme-bar">',
            '  <span class="nme-label">每页</span>',
            '  <select id="nme-size" class="nme-sel">',
            '    <option value="20"' + (CFG.pageSize === 20 ? ' selected' : '') + '>20</option>',
            '    <option value="40"' + (CFG.pageSize === 40 ? ' selected' : '') + '>40</option>',
            '    <option value="60"' + (CFG.pageSize === 60 ? ' selected' : '') + '>60</option>',
            '    <option value="80"' + (CFG.pageSize === 80 ? ' selected' : '') + '>80</option>',
            '  </select>',
            '  <span class="nme-label">排序</span>',
            '  <select id="nme-sort" class="nme-sel">' + sortOptions + '</select>',
            '  <button id="nme-dir" class="nme-btn" type="button">' + (CFG.sortDir === 'DESC' ? '降序' : '升序') + '</button>',
            '  <input id="nme-kw" class="nme-input" type="search" placeholder="关键词（模组名 / 描述）" value="' + escapeAttr(CFG.keyword || ctx.keyword || '') + '">',
            '</div>',
            '<div class="nme-bar">',
            '  <span class="nme-label">快捷</span>',
            '  <button class="nme-chip" type="button" data-chip="zh">简中</button>',
            '  <button class="nme-chip" type="button" data-chip="zht">繁中</button>',
            '  <button class="nme-chip" type="button" data-chip="tr">翻译</button>',
            '  <button class="nme-chip" type="button" data-chip="hot">热门（下载≥1000）</button>',
            '  <span class="nme-sep"></span>',
            '  <span class="nme-label">下载量≥</span><input id="nme-dl" class="nme-input nme-num" type="number" min="0" value="' + (CFG.minDownloads || 0) + '">',
            '  <span class="nme-label">点赞≥</span><input id="nme-ed" class="nme-input nme-num" type="number" min="0" value="' + (CFG.minEndorsements || 0) + '">',
            '  <span class="nme-label">大小≤MB</span><input id="nme-mb" class="nme-input nme-num" type="number" min="0" value="' + (CFG.maxSizeMB || 0) + '">',
            '  <button id="nme-reset" class="nme-btn" type="button">重置</button>',
            '  <button id="nme-view" class="nme-btn nme-btn-accent" type="button">切换到原生视图</button>',
            '</div>',
            '<div class="nme-bar nme-bar-cn">',
            '  <span class="nme-label">中文找游戏</span>',
            '  <input id="nme-cn" class="nme-input nme-cn-input" type="search" placeholder="输入中文名，如 剑星 / 上古卷轴5，回车查找" value="' + (CJK_RE.test(ctx.keyword || '') ? escapeAttr(ctx.keyword) : '') + '">',
            '  <button id="nme-cn-go" class="nme-btn nme-btn-accent" type="button">查找游戏</button>',
            '  <span id="nme-cn-msg" class="nme-cn-msg"></span>',
            '  <span class="nme-sep"></span>',
            '  <button id="nme-ai-digest" class="nme-btn" type="button">AI 解读本页</button>',
            '  <button id="nme-ai-cfg2" class="nme-btn" type="button">AI 配置</button>',
            '</div>',
            '<div id="nme-cn-results" class="nme-cn-results" hidden></div>',
            '<div id="nme-ai-digest-out" class="nme-ai-out" hidden></div>',
            '</div>',
            '<div id="nme-status" class="nme-status"><span id="nme-msg">准备中…</span> <span id="nme-counts">共 <b id="nme-total">—</b> 条结果 · 已加载 <b id="nme-loaded">0</b> 条</span></div>',
            '<div id="nme-grid" class="nme-grid"></div>',
            '<div id="nme-sentinel" class="nme-sentinel">滚动到底部自动加载更多</div>'
        ].join('');

        // 快捷筛选状态回显
        for (const k in state.chips) {
            if (state.chips[k]) {
                const b = panel.querySelector('.nme-chip[data-chip="' + k + '"]');
                if (b) b.classList.add('nme-chip-on');
            }
        }

        return panel;
    }

    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function bindPanel(panel) {
        const on = (sel, ev, fn) => {
            const el = panel.querySelector(sel);
            if (el) el.addEventListener(ev, fn);
        };

        on('#nme-size', 'change', function () {
            CFG.pageSize = parseInt(this.value, 10) || 20;
            saveCfg();
            refreshCapsule();
            loadPage(true);
        });

        on('#nme-sort', 'change', function () {
            CFG.sortBy = this.value;
            saveCfg();
            refreshCapsule();
            loadPage(true);
        });

        on('#nme-dir', 'click', function () {
            CFG.sortDir = CFG.sortDir === 'DESC' ? 'ASC' : 'DESC';
            this.textContent = CFG.sortDir === 'DESC' ? '降序' : '升序';
            saveCfg();
            refreshCapsule();
            loadPage(true);
        });

        const kw = panel.querySelector('#nme-kw');
        if (kw) {
            kw.addEventListener('search', function () {
                CFG.keyword = this.value;
                saveCfg();
                loadPage(true);
            });
            kw.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    CFG.keyword = this.value;
                    saveCfg();
                    loadPage(true);
                }
            });
        }

        const numChange = debounce(function () {
            CFG.minDownloads = parseInt(panel.querySelector('#nme-dl').value, 10) || 0;
            CFG.minEndorsements = parseInt(panel.querySelector('#nme-ed').value, 10) || 0;
            CFG.maxSizeMB = parseInt(panel.querySelector('#nme-mb').value, 10) || 0;
            saveCfg();
            loadPage(true);
        }, 400);
        ['#nme-dl', '#nme-ed', '#nme-mb'].forEach(function (sel) {
            const el = panel.querySelector(sel);
            if (el) el.addEventListener('input', numChange);
        });

        panel.querySelectorAll('.nme-chip').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const key = this.getAttribute('data-chip');
                state.chips[key] = !state.chips[key];
                this.classList.toggle('nme-chip-on', state.chips[key]);
                CFG.chips = normChips(state.chips);
                saveCfg();
                refreshCapsule();
                loadPage(true);
            });
        });

        on('#nme-reset', 'click', function () {
            CFG.keyword = '';
            CFG.minDownloads = 0;
            CFG.minEndorsements = 0;
            CFG.maxSizeMB = 0;
            state.chips = { zh: false, zht: false, tr: false, hot: false };
            CFG.chips = normChips(state.chips);
            panel.querySelectorAll('.nme-chip').forEach(function (b) { b.classList.remove('nme-chip-on'); });
            const k = panel.querySelector('#nme-kw'); if (k) k.value = '';
            const d = panel.querySelector('#nme-dl'); if (d) d.value = '0';
            const e2 = panel.querySelector('#nme-ed'); if (e2) e2.value = '0';
            const m = panel.querySelector('#nme-mb'); if (m) m.value = '0';
            saveCfg();
            refreshCapsule();
            loadPage(true);
        });

        on('#nme-view', 'click', function () {
            setView(CFG.view === 'enhanced' ? 'native' : 'enhanced');
        });

        // —— 中文找游戏 ——
        const cn = panel.querySelector('#nme-cn');
        if (cn) {
            cn.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); runCnGameSearch(); }
            });
        }
        on('#nme-cn-go', 'click', runCnGameSearch);
        on('#nme-ai-cfg2', 'click', openAiSettings);
        on('#nme-ai-digest', 'click', runPageDigest);

        // 关键词里出现中文时，顺手提示走「中文找游戏」
        const kwEl = panel.querySelector('#nme-kw');
        if (kwEl && cn) {
            kwEl.addEventListener('input', function () {
                if (CJK_RE.test(this.value)) {
                    cn.value = this.value;
                    setCnMsg('中文关键词在 N 网搜不到，改按「中文找游戏」解析', 'warn');
                } else {
                    setCnMsg('', '');
                }
            });
            kwEl.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && CJK_RE.test(this.value)) {
                    e.preventDefault();
                    cn.value = this.value;
                    runCnGameSearch();
                }
            });
        }
    }

    let toastTimer = null;
    /** 右下角提示，用于视图切换与菜单操作的结果反馈 */
    function showToast(title, detail, kind) {
        if (!document.body) return;
        let t = $('#nme-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'nme-toast';
            t.setAttribute('role', 'status');
            t.setAttribute('aria-live', 'polite');
            document.body.appendChild(t);
        }
        t.className = 'nme-toast nme-toast-' + (kind || 'enhanced') + ' nme-toast-on';
        t.innerHTML = '<b>' + escapeHtml(title) + '</b><span>' + escapeHtml(detail || '') + '</span>';
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.classList.remove('nme-toast-on'); }, 3200);
    }

    /** 切换视图后给一次明确反馈，避免用户不知道刚才动了什么 */
    function showModeToast(view) {
        if (view === 'enhanced') {
            showToast('增强视图已开启', CFG.pageSize + ' 条/页 · 无限滚动 · 中文筛选 · 中文找游戏', 'enhanced');
        } else {
            showToast('已切回原生视图', '使用站点默认 20 条/页与自带筛选，增强工具条已隐藏', 'native');
        }
    }

    function setView(view) {
        const prev = CFG.view;
        CFG.view = view;
        saveCfg();
        const body = document.body;
        if (!body) return;
        body.classList.toggle('nme-view-enhanced', view === 'enhanced');
        body.classList.toggle('nme-view-native', view === 'native');

        const btn = $('#nme-view');
        if (btn) btn.textContent = (view === 'enhanced') ? '切换到原生视图' : '开启增强视图';

        // 同步右下角浮动胶囊的视图状态
        const capBtn = $('#nme-cap-btn');
        const capText = $('#nme-cap-text');
        const capDot = $('#nme-cap-dot');
        if (capBtn) {
            capBtn.classList.toggle('nme-cap-on', view === 'enhanced');
            capBtn.setAttribute('aria-pressed', view === 'enhanced' ? 'true' : 'false');
            capBtn.setAttribute('title', view === 'enhanced'
                ? '当前：增强视图（已开启）· 点击展开快捷操作'
                : '当前：原生视图（增强已关闭）· 点击展开快捷操作');
        }
        if (capText) capText.textContent = (view === 'enhanced') ? '增强视图' : '原生视图';
        if (capDot) capDot.classList.toggle('nme-cap-dot-native', view !== 'enhanced');

        if (view === 'enhanced' && state.loaded === 0 && state.ctx &&
            (state.ctx.mode === 'list' || state.ctx.mode === 'search')) {
            loadPage(true);
        }
        if (prev !== view) {
            if ($('#nme-panel')) showModeToast(view);
            else showToast('视图设置已保存', '回到列表或搜索页后生效', 'native');
        }
        refreshMenu();
    }

    // ==================== 右下角浮动胶囊 ====================

    /**
     * 常驻右下角的浮动胶囊：
     * - 收起态：一个胶囊按钮，显示当前视图状态（绿点=增强，琥珀点=原生）
     * - 展开态：一个快捷操作面板，根据当前页面类型提供不同入口
     *   列表/搜索页：视图切换、每页条数、快捷筛选、排序、AI 解读本页
     *   模组详情页：视图切换、AI 翻译、AI 分析
     *   合集页：视图切换、批量下载
     *   其它页：视图切换、AI 配置
     * 始终挂在 body 上，不依赖增强视图面板是否存在。
     */
    function mountCapsule() {
        if ($('#nme-cap-btn')) return;
        const ctx = state.ctx;
        const mode = ctx ? ctx.mode : null;
        const isList = mode === 'list' || mode === 'search';

        // 与浮动按钮坞共用同一个容器，避免两个独立 fixed 元素互相遮挡
        const dock = ensureDock();

        // 收起态按钮
        const btn = document.createElement('button');
        btn.id = 'nme-cap-btn';
        btn.type = 'button';
        btn.innerHTML =
            '<span id="nme-cap-dot" class="nme-cap-dot" aria-hidden="true"></span>' +
            '<span id="nme-cap-text">增强视图</span>' +
            '<span class="nme-cap-caret" aria-hidden="true">▾</span>';

        // 展开态面板
        const panel = document.createElement('div');
        panel.id = 'nme-cap-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'N网增强 快捷操作');

        let body = '';
        body += '<div class="nme-cap-head"><span class="nme-cap-title">N网增强 · 快捷操作</span>' +
            '<button class="nme-cap-close" type="button" aria-label="关闭">✕</button></div>';

        // 视图切换（所有页面都有）
        body += '<div class="nme-cap-row nme-cap-mode">';
        body += '<button class="nme-cap-btn2 nme-cap-view" data-view="enhanced" type="button">增强视图</button>';
        body += '<button class="nme-cap-btn2 nme-cap-view" data-view="native" type="button">原生视图</button>';
        body += '</div>';
        body += '<div class="nme-cap-sep"></div>';

        if (isList) {
            // 每页条数
            body += '<div class="nme-cap-row"><span class="nme-cap-label">每页</span>';
            PAGE_SIZES.forEach(function (s) {
                body += '<button class="nme-cap-btn2 nme-cap-size" data-size="' + s + '" type="button">' + s + '</button>';
            });
            body += '</div>';

            // 快捷筛选
            body += '<div class="nme-cap-row"><span class="nme-cap-label">筛选</span>';
            body += '<button class="nme-cap-chip nme-cap-fchip" data-chip="zh" type="button">简中</button>';
            body += '<button class="nme-cap-chip nme-cap-fchip" data-chip="zht" type="button">繁中</button>';
            body += '<button class="nme-cap-chip nme-cap-fchip" data-chip="tr" type="button">翻译</button>';
            body += '<button class="nme-cap-chip nme-cap-fchip" data-chip="hot" type="button">热门</button>';
            body += '</div>';

            // 排序
            body += '<div class="nme-cap-row"><span class="nme-cap-label">排序</span>';
            body += '<select class="nme-cap-btn2 nme-cap-sort" style="flex:1;min-width:0;">';
            SORTS.forEach(function (s) {
                body += '<option value="' + s[0] + '"' + (CFG.sortBy === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
            });
            body += '</select>';
            body += '<button class="nme-cap-btn2 nme-cap-dir" type="button">' + (CFG.sortDir === 'DESC' ? '降序' : '升序') + '</button>';
            body += '</div>';
            body += '<div class="nme-cap-sep"></div>';

            // AI 解读本页
            body += '<div class="nme-cap-row">';
            body += '<button class="nme-cap-btn2 nme-cap-ai nme-cap-digest" type="button" style="flex:1;">✦ AI 解读本页</button>';
            body += '</div>';
        }
        // 详情页 / 合集页的 AI 与下载入口已移到右下角浮动按钮坞，这里不再重复

        // 通用：AI 配置
        body += '<div class="nme-cap-row">';
        body += '<button class="nme-cap-btn2 nme-cap-aicfg" type="button" style="flex:1;">⚙ AI 接口配置</button>';
        body += '</div>';

        body += '<div class="nme-cap-hint">点击胶囊按钮可收起；列表/搜索页的快捷操作即时生效。</div>';

        panel.innerHTML = body;
        dock.appendChild(panel);
        dock.appendChild(btn);

        // —— 事件绑定 ——
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            // 面板互斥：打开快捷面板时收起 AI/下载面板
            if (!dock.classList.contains('nme-cap-open')) closeFab();
            dock.classList.toggle('nme-cap-open');
        });
        const closeBtn = panel.querySelector('.nme-cap-close');
        if (closeBtn) closeBtn.addEventListener('click', function () { dock.classList.remove('nme-cap-open'); });

        // 视图切换
        panel.querySelectorAll('.nme-cap-view').forEach(function (b) {
            b.addEventListener('click', function () {
                const v = this.getAttribute('data-view');
                if (v === 'enhanced' || v === 'native') setView(v);
                dock.classList.remove('nme-cap-open');
            });
        });

        if (isList) {
            // 每页条数
            panel.querySelectorAll('.nme-cap-size').forEach(function (b) {
                b.addEventListener('click', function () {
                    const s = parseInt(this.getAttribute('data-size'), 10);
                    if (PAGE_SIZES.indexOf(s) >= 0) {
                        CFG.pageSize = s;
                        saveCfg();
                        refreshCapsule();
                        loadPage(true);
                    }
                });
            });
            // 快捷筛选
            panel.querySelectorAll('.nme-cap-fchip').forEach(function (b) {
                b.addEventListener('click', function () {
                    const k = this.getAttribute('data-chip');
                    state.chips[k] = !state.chips[k];
                    CFG.chips = normChips(state.chips);
                    saveCfg();
                    refreshCapsule();
                    // 同步顶部工具条的 chip 状态
                    const tb = $('#nme-panel .nme-chip[data-chip="' + k + '"]');
                    if (tb) tb.classList.toggle('nme-chip-on', state.chips[k]);
                    loadPage(true);
                });
            });
            // 排序
            const sortSel = panel.querySelector('.nme-cap-sort');
            if (sortSel) sortSel.addEventListener('change', function () {
                CFG.sortBy = this.value;
                saveCfg();
                // 同步顶部下拉
                const tb = $('#nme-sort');
                if (tb) tb.value = CFG.sortBy;
                loadPage(true);
            });
            const dirBtn = panel.querySelector('.nme-cap-dir');
            if (dirBtn) dirBtn.addEventListener('click', function () {
                CFG.sortDir = CFG.sortDir === 'DESC' ? 'ASC' : 'DESC';
                this.textContent = CFG.sortDir === 'DESC' ? '降序' : '升序';
                saveCfg();
                const tb = $('#nme-dir');
                if (tb) tb.textContent = CFG.sortDir === 'DESC' ? '降序' : '升序';
                loadPage(true);
            });
            // AI 解读本页
            const digestBtn = panel.querySelector('.nme-cap-digest');
            if (digestBtn) digestBtn.addEventListener('click', function () {
                dock.classList.remove('nme-cap-open');
                runPageDigest();
            });
        }

        // AI 配置
        const aicfgBtn = panel.querySelector('.nme-cap-aicfg');
        if (aicfgBtn) aicfgBtn.addEventListener('click', function () {
            dock.classList.remove('nme-cap-open');
            openAiSettings();
        });

        refreshCapsule();
    }

    /** 同步胶囊里各按钮的激活态（视图、每页条数、筛选、排序方向） */
    function refreshCapsule() {
        const cap = $('#nme-dock');
        if (!cap) return;

        // 视图按钮
        cap.querySelectorAll('.nme-cap-view').forEach(function (b) {
            b.classList.toggle('nme-cap-active', b.getAttribute('data-view') === CFG.view);
        });
        // 每页条数
        cap.querySelectorAll('.nme-cap-size').forEach(function (b) {
            b.classList.toggle('nme-cap-active', parseInt(b.getAttribute('data-size'), 10) === CFG.pageSize);
        });
        // 快捷筛选
        cap.querySelectorAll('.nme-cap-fchip').forEach(function (b) {
            b.classList.toggle('nme-cap-on', !!state.chips[b.getAttribute('data-chip')]);
        });
        // 排序下拉与方向
        const sortSel = cap.querySelector('.nme-cap-sort');
        if (sortSel) sortSel.value = CFG.sortBy;
        const dirBtn = cap.querySelector('.nme-cap-dir');
        if (dirBtn) dirBtn.textContent = CFG.sortDir === 'DESC' ? '降序' : '升序';

        // 胶囊按钮的视图点颜色
        const dot = $('#nme-cap-dot');
        if (dot) dot.classList.toggle('nme-cap-dot-native', CFG.view !== 'enhanced');
        const capBtn = $('#nme-cap-btn');
        if (capBtn) capBtn.classList.toggle('nme-cap-on', CFG.view === 'enhanced');
        const capText = $('#nme-cap-text');
        if (capText) capText.textContent = (CFG.view === 'enhanced') ? '增强视图' : '原生视图';
    }

    // ==================== 样式 ====================

    function addStyle() {
        const css = [
            'body.nme-view-enhanced [data-nme-native="1"]{display:none !important;}',
            'body.nme-view-enhanced .mods-grid{display:none !important;}',
            'body.nme-view-native #nme-toolbar,body.nme-view-native #nme-grid,',
            'body.nme-view-native #nme-status,body.nme-view-native #nme-sentinel{display:none !important;}',
            'body.nme-view-native #nme-panel{margin:0;}',
            'body.nme-view-enhanced nav[aria-label*="Pagination" i]{display:none !important;}',
            '#nme-panel{margin:0 0 1.5rem;}',
            '#nme-panel .nme-bar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-bottom:.5rem;}',
            '#nme-panel .nme-label{font-size:.8125rem;opacity:.7;white-space:nowrap;}',
            '#nme-panel .nme-sel, #nme-panel .nme-input{background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.16);border-radius:.375rem;padding:.3rem .5rem;font-size:.8125rem;line-height:1.2;}',
            // 原生下拉列表在 macOS 上默认是白底，继承文字色后变成白底浅字；声明深色配色并显式设置 option 颜色
            '#nme-panel{color-scheme:dark;}',
            '#nme-panel .nme-sel{color-scheme:dark;}',
            '#nme-panel .nme-sel option{background:#1b1b1f;color:#f0f0f0;}',
            '#nme-panel .nme-sel option:checked{background:#3a3a42;color:#fff;}',
            '#nme-panel .nme-input{min-width:12rem;flex:1 1 12rem;}',
            '#nme-panel .nme-num{width:6rem;flex:0 0 6rem;}',
            '#nme-panel .nme-btn{background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.16);border-radius:.375rem;padding:.3rem .6rem;font-size:.8125rem;cursor:pointer;}',
            '#nme-panel .nme-btn:hover{background:rgba(255,255,255,.12);}',
            '#nme-panel .nme-btn-accent{border-color:rgba(255,255,255,.32);}',
            '#nme-panel .nme-chip{background:transparent;color:inherit;border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:.2rem .7rem;font-size:.8125rem;cursor:pointer;}',
            '#nme-panel .nme-chip-on{background:#d34a4a;border-color:#d34a4a;color:#fff;}',
            '#nme-panel .nme-sep{width:1px;height:1.25rem;background:rgba(255,255,255,.16);margin:0 .25rem;}',
            '#nme-panel .nme-status{font-size:.8125rem;opacity:.75;margin:.35rem 0 .75rem;}',
            '#nme-panel .nme-status-err{color:#ff8a8a;opacity:1;}',
            '#nme-panel .nme-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));}',
            '#nme-panel .nme-sentinel{text-align:center;font-size:.8125rem;opacity:.55;padding:1.25rem 0;}',
            '#nme-panel .nme-badges{display:inline-flex;gap:.25rem;margin-left:.35rem;vertical-align:middle;}',
            '#nme-panel .nme-badge{font-size:.6875rem;line-height:1.2;padding:.1rem .35rem;border-radius:.25rem;border:1px solid currentColor;}',
            '#nme-panel .nme-badge-hans{color:#e05c5c;}',
            '#nme-panel .nme-badge-hant{color:#d68b3c;}',
            '#nme-panel .nme-badge-zh{color:#e05c5c;}',
            '#nme-panel .nme-badge-tr{color:#5ca0e0;}',
            '#nme-panel .nme-badge-direct{color:#3fa66a;}',
            // —— 右下角统一浮动坞（AI / 下载 / 配置 / 增强视图）——
            // 所有浮动入口共用一个容器：按钮在流内横竖排列，弹出面板绝对定位在坞的上方，
            // 两个面板互斥（开一个关另一个）。结构上杜绝「两个浮层互相遮挡」。
            // 坞本身 pointer-events:none，只有真正的按钮可点，
            // 不会再出现「透明大容器盖住按钮、点击被吃掉」的情况。
            '#nme-dock{position:fixed;right:16px;bottom:16px;z-index:10000;display:flex;flex-direction:column;',
            '  align-items:flex-end;gap:.45rem;pointer-events:none;}',
            '#nme-fab-btns{order:1;display:flex;flex-direction:row;align-items:center;justify-content:flex-end;',
            '  gap:.4rem;flex-wrap:wrap;pointer-events:auto;}',
            '#nme-cap-btn{order:2;pointer-events:auto;}',
            '.nme-fab-btn{display:inline-flex;align-items:center;height:34px;padding:0 .85rem;border-radius:999px;',
            '  border:1px solid rgba(255,255,255,.32);background:rgba(16,16,18,.96);color:#f0f0f2;',
            '  font-weight:600;font-size:.8125rem;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.6);',
            '  transition:transform .15s ease,background .15s ease;}',
            '.nme-fab-btn:hover{transform:translateY(-1px);background:rgba(36,36,42,.98);}',
            '.nme-fab-btn-ai{border-color:rgba(211,74,74,.6);color:#f6c9c9;}',
            '.nme-fab-btn-ai:hover{background:rgba(211,74,74,.28);}',
            '.nme-fab-btn-dl{border-color:rgba(63,166,106,.55);color:#c6e8d4;}',
            '.nme-fab-btn-dl:hover{background:rgba(63,166,106,.26);}',
            '.nme-fab-btn-cfg{border-color:rgba(255,255,255,.28);color:#dcdce2;}',
            '.nme-fab-btn-on{background:#d34a4a;border-color:#d34a4a;color:#fff;}',
            '.nme-fab-btn-on:hover{background:#e05656;}',
            '#nme-fab-card{position:absolute;right:0;bottom:calc(100% + .5rem);z-index:2;pointer-events:auto;',
            '  width:min(26rem,calc(100vw - 2rem));max-height:min(70vh,34rem);overflow-y:auto;',
            '  padding:.75rem .85rem;border-radius:.75rem;border:1px solid rgba(255,255,255,.2);',
            '  background:#17171a;color:#e9e9ec;box-shadow:0 14px 44px rgba(0,0,0,.68);',
            '  animation:nme-fab-in .16s ease;}',
            '@keyframes nme-fab-in{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}',
            '.nme-fab-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem;',
            '  margin-bottom:.55rem;padding-bottom:.45rem;border-bottom:1px solid rgba(255,255,255,.12);}',
            '.nme-fab-title{font-weight:700;font-size:.85rem;color:#e9e9ec;}',
            '.nme-fab-close{background:none;border:none;color:rgba(255,255,255,.55);cursor:pointer;',
            '  font-size:1rem;line-height:1;padding:0 .2rem;}',
            '.nme-fab-close:hover{color:#fff;}',
            '.nme-fab-sec{display:none;}',
            '.nme-fab-sec.nme-fab-sec-on{display:block;}',
            // 浮层内的 AI / 下载条：改成紧凑版，不再是页面里的大块卡片
            '#nme-fab-card #nme-ai-bar,#nme-fab-card #nme-dl-bar{margin:0;padding:0;border:none;',
            '  border-radius:0;background:none;}',
            '#nme-fab-card #nme-ai-bar .nme-ai-head,#nme-fab-card #nme-dl-bar .nme-dl-head{display:none;}',
            '#nme-fab-card #nme-ai-bar .nme-ai-actions,#nme-fab-card #nme-dl-bar .nme-dl-actions{margin-top:0;}',
            '#nme-fab-card .nme-ai-btn,#nme-fab-card .nme-dl-btn{background:rgba(255,255,255,.09);color:#eee;',
            '  border:1px solid rgba(255,255,255,.22);}',
            '#nme-fab-card .nme-ai-btn:hover,#nme-fab-card .nme-dl-btn:hover{background:rgba(255,255,255,.17);}',
            '#nme-fab-card .nme-ai-btn-accent,#nme-fab-card .nme-dl-btn-accent{background:#d34a4a;border-color:#d34a4a;color:#fff;}',
            '#nme-fab-card .nme-dl-list{max-height:16rem;}',
            '#nme-fab-card .nme-dl-row{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.14);}',
            '#nme-fab-card .nme-dl-meta,#nme-fab-card .nme-dl-sub{opacity:.75;}',
            '#nme-fab-card .nme-dl-log{background:rgba(0,0,0,.35);}',

            // —— 增强视图胶囊（常驻快捷操作，挂在统一浮动坞里）——
            '#nme-cap-btn{display:inline-flex;align-items:center;gap:.5rem;height:38px;padding:0 .95rem;border-radius:999px;',
            '  border:1px solid rgba(255,255,255,.3);background:rgba(20,20,22,.94);color:#e8e8e8;',
            '  font-weight:600;font-size:.8125rem;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.55);backdrop-filter:blur(8px);',
            '  transition:transform .15s ease,box-shadow .15s ease;border-color:rgba(63,166,106,.5);}',
            '#nme-cap-btn:hover{transform:translateY(-1px);box-shadow:0 6px 22px rgba(0,0,0,.6);}',
            '#nme-cap-btn.nme-cap-on{border-color:rgba(63,166,106,.65);}',
            '#nme-cap-btn .nme-cap-dot{width:9px;height:9px;border-radius:50%;background:#3fa66a;box-shadow:0 0 0 3px rgba(63,166,106,.2);transition:background .2s;}',
            '#nme-cap-btn .nme-cap-dot.nme-cap-dot-native{background:#e0a33c;box-shadow:0 0 0 3px rgba(224,163,60,.22);}',
            '#nme-cap-btn .nme-cap-caret{opacity:.55;font-size:.8em;line-height:1;transition:transform .2s;}',
            '#nme-dock.nme-cap-open #nme-cap-btn .nme-cap-caret{transform:rotate(180deg);opacity:.9;}',
            '#nme-cap-panel{position:absolute;right:0;bottom:calc(100% + .5rem);z-index:1;',
            '  width:min(20rem,82vw);max-height:70vh;overflow-y:auto;padding:.75rem;border-radius:1rem;',
            '  border:1px solid rgba(255,255,255,.22);background:rgba(22,22,26,.97);color:#eee;',
            '  box-shadow:0 10px 36px rgba(0,0,0,.6);backdrop-filter:blur(12px);',
            '  opacity:0;transform:translateY(6px) scale(.98);pointer-events:none;transition:opacity .18s ease,transform .18s ease;}',
            '#nme-dock.nme-cap-open #nme-cap-panel{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}',
            '#nme-cap-panel .nme-cap-row{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;margin-bottom:.55rem;}',
            '#nme-cap-panel .nme-cap-row:last-child{margin-bottom:0;}',
            '#nme-cap-panel .nme-cap-label{font-size:.75rem;opacity:.6;white-space:nowrap;min-width:3.2rem;}',
            '#nme-cap-panel .nme-cap-btn2{background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.18);',
            '  border-radius:999px;padding:.28rem .7rem;font-size:.78rem;cursor:pointer;line-height:1.2;white-space:nowrap;}',
            '#nme-cap-panel .nme-cap-btn2:hover{background:rgba(255,255,255,.13);}',
            '#nme-cap-panel .nme-cap-btn2.nme-cap-active{background:#3fa66a;border-color:#3fa66a;color:#06130b;font-weight:600;}',
            '#nme-cap-panel .nme-cap-chip{background:transparent;color:inherit;border:1px solid rgba(255,255,255,.2);',
            '  border-radius:999px;padding:.24rem .65rem;font-size:.75rem;cursor:pointer;}',
            '#nme-cap-panel .nme-cap-chip.nme-cap-on{background:#d34a4a;border-color:#d34a4a;color:#fff;}',
            '#nme-cap-panel .nme-cap-ai{background:rgba(211,74,74,.16);border-color:rgba(211,74,74,.5);color:#f3b4b4;}',
            '#nme-cap-panel .nme-cap-ai:hover{background:rgba(211,74,74,.28);}',
            '#nme-cap-panel .nme-cap-sep{height:1px;background:rgba(255,255,255,.14);margin:.55rem 0;}',
            '#nme-cap-panel .nme-cap-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:.35rem;}',
            '#nme-cap-panel .nme-cap-title{font-size:.8rem;font-weight:700;color:#d34a4a;}',
            '#nme-cap-panel .nme-cap-close{background:none;border:none;color:rgba(255,255,255,.5);cursor:pointer;font-size:1rem;line-height:1;padding:0 .2rem;}',
            '#nme-cap-panel .nme-cap-close:hover{color:#fff;}',
            '#nme-cap-panel .nme-cap-mode{display:flex;gap:.3rem;}',
            '#nme-cap-panel .nme-cap-mode button{flex:1;}',
            '#nme-cap-panel .nme-cap-hint{font-size:.7rem;opacity:.5;margin-top:.3rem;line-height:1.4;}',
            // 提示条放左下角：右下角被统一浮动坞占用，避免盖住按钮
            '#nme-toast{position:fixed;left:16px;bottom:16px;z-index:10000;max-width:min(22rem,80vw);',
            '  padding:.6rem .8rem;border-radius:.55rem;border:1px solid rgba(255,255,255,.2);',
            '  background:rgba(20,20,22,.96);color:#eee;font-size:.8125rem;line-height:1.45;',
            '  box-shadow:0 6px 24px rgba(0,0,0,.5);opacity:0;transform:translateY(8px);',
            '  transition:opacity .18s ease,transform .18s ease;pointer-events:none;}',
            '#nme-toast.nme-toast-on{opacity:1;transform:translateY(0);}',
            '#nme-toast b{display:block;font-size:.875rem;margin-bottom:.15rem;color:#d34a4a;}',
            '#nme-toast.nme-toast-native b{color:#e0a33c;}',
            // 归档自测/下载反馈要用到这三种状态色，否则成功和失败长得一样
            '#nme-toast.nme-toast-ok b{color:#69c08a;}',
            '#nme-toast.nme-toast-err b{color:#ff8a8a;}',
            '#nme-toast.nme-toast-busy b{color:#8ab4ff;}',
            '#nme-toast span{opacity:.75;}',

            // —— 下载历史更新检查 ——
            // 用 !important 覆盖，避免其他脚本写入的内联背景色把高亮擦掉
            '#nme-hist-bar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:.6rem 0;padding:.55rem .7rem;',
            '  border:1px solid rgba(217,143,64,.45);border-radius:.4rem;background:rgba(217,143,64,.08);',
            '  color:#e6c79a;font-size:.8125rem;}',
            '#nme-hist-bar b{color:#f0b267;font-size:.875rem;}',
            '#nme-hist-bar #nme-hist-count{opacity:.8;}',
            '#nme-hist-bar button{padding:.2rem .55rem;border:1px solid rgba(217,143,64,.5);border-radius:.3rem;',
            '  background:rgba(217,143,64,.14);color:#f0c37a;font-size:.75rem;cursor:pointer;}',
            '#nme-hist-bar button:hover{background:rgba(217,143,64,.26);}',
            '#nme-hist-bar .nme-hist-tip{flex-basis:100%;opacity:.6;font-size:.75rem;}',
            'tr.nme-hist-row > td{background-color:rgba(217,143,64,.15)!important;}',
            'tr.nme-hist-row > td:first-child{box-shadow:inset 3px 0 0 #d98f40;}',
            'tr.nme-hist-row.nme-hist-noedge > td:first-child{box-shadow:none;}',
            '.nme-hist-badge{display:inline-block;margin-left:.4rem;padding:0 .35rem;border-radius:.25rem;',
            '  background:#d98f40;color:#1b1206;font-size:.6875rem;font-weight:700;vertical-align:middle;}',
            'table.datatable.nme-hist-only tbody tr:not(.nme-hist-row){display:none!important;}',

            // —— 中文找游戏 ——
            '#nme-panel .nme-bar-cn{margin-top:.1rem;}',
            '#nme-panel .nme-cn-input{flex:1 1 18rem;}',
            '#nme-panel .nme-cn-msg{font-size:.8125rem;opacity:.7;}',
            '#nme-panel .nme-cn-msg-ok{color:#69c08a;opacity:1;}',
            '#nme-panel .nme-cn-msg-busy{color:#e0a33c;opacity:1;}',
            '#nme-panel .nme-cn-msg-warn{color:#e0a33c;opacity:1;}',
            '#nme-panel .nme-cn-msg-err{color:#ff8a8a;opacity:1;}',
            '#nme-panel .nme-cn-results{display:flex;flex-wrap:wrap;gap:.5rem;margin:.35rem 0 .85rem;}',
            '#nme-panel .nme-cn-item{display:flex;flex-direction:column;gap:.1rem;padding:.45rem .7rem;min-width:11rem;',
            '  border:1px solid rgba(255,255,255,.18);border-radius:.45rem;color:inherit;text-decoration:none;background:rgba(255,255,255,.03);}',
            '#nme-panel .nme-cn-item:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.3);}',
            '#nme-panel .nme-cn-name{font-weight:600;font-size:.875rem;}',
            '#nme-panel .nme-cn-domain{font-size:.75rem;opacity:.6;}',
            '#nme-panel .nme-cn-count{font-size:.75rem;opacity:.75;}',
            '#nme-panel .nme-cn-src{font-size:.6875rem;opacity:.5;}',
            '#nme-panel .nme-cn-empty{font-size:.8125rem;opacity:.8;}',

            // —— AI 工具条（列表页 + 详情页）——
            '#nme-ai-bar{margin:1rem 0;padding:.8rem .95rem;border:1px solid rgba(255,255,255,.16);',
            '  border-radius:.6rem;background:rgba(255,255,255,.04);}',
            '#nme-ai-bar .nme-ai-head{display:flex;align-items:baseline;gap:.55rem;flex-wrap:wrap;}',
            '#nme-ai-bar .nme-ai-title{font-weight:700;color:#d34a4a;}',
            '#nme-ai-bar .nme-ai-sub{font-size:.75rem;opacity:.6;}',
            '#nme-ai-bar .nme-ai-actions{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-top:.6rem;}',
            '#nme-ai-bar .nme-ai-btn,#nme-panel .nme-ai-btn{background:rgba(255,255,255,.06);color:inherit;',
            '  border:1px solid rgba(255,255,255,.16);border-radius:.375rem;padding:.3rem .6rem;font-size:.8125rem;cursor:pointer;}',
            '#nme-ai-bar .nme-ai-btn:hover,#nme-panel .nme-ai-btn:hover{background:rgba(255,255,255,.12);}',
            '#nme-ai-bar .nme-ai-btn:disabled,#nme-panel .nme-ai-btn:disabled{opacity:.5;cursor:progress;}',
            '#nme-ai-bar .nme-ai-btn-accent,#nme-panel .nme-ai-btn-accent{background:#d34a4a;border-color:#d34a4a;color:#fff;}',
            '#nme-ai-status{font-size:.75rem;opacity:.7;}',
            '.nme-ai-status-ok{color:#69c08a !important;opacity:1;}',
            '.nme-ai-status-err,.nme-ai-status-err .nme-ai-status{color:#ff8a8a !important;opacity:1;}',
            '.nme-ai-status-busy{color:#e0a33c !important;opacity:1;}',
            '.nme-ai-status-warn{color:#e0a33c !important;opacity:1;}',
            '.nme-ai-out{margin:.35rem 0 .9rem;}',
            '#nme-ai-bar .nme-ai-out{margin-top:.75rem;}',
            '.nme-ai-card{border:1px solid rgba(255,255,255,.14);border-radius:.5rem;padding:.75rem .9rem;',
            '  background:rgba(255,255,255,.03);}',
            '.nme-ai-card-head{font-weight:600;margin-bottom:.5rem;display:flex;flex-wrap:wrap;gap:.3rem .75rem;align-items:baseline;}',
            '.nme-ai-tip{font-size:.75rem;font-weight:400;opacity:.6;}',
            '.nme-ai-text{font-size:.875rem;line-height:1.65;word-break:break-word;}',
            '.nme-ai-kv{display:flex;gap:.5rem;margin:.25rem 0;}',
            '.nme-ai-k{flex:0 0 5.5rem;opacity:.6;font-size:.8125rem;}',
            '.nme-ai-v{flex:1;font-size:.875rem;line-height:1.6;}',
            '.nme-ai-sec-title{font-weight:600;margin:.65rem 0 .25rem;}',
            '.nme-ai-list{margin:0;padding-left:1.1rem;}',
            '.nme-ai-list li{margin:.2rem 0;font-size:.875rem;line-height:1.55;}',
            '.nme-ai-list a{color:#7db4e6;text-decoration:none;}',
            '.nme-ai-list a:hover{text-decoration:underline;}',
            '.nme-ai-why{display:block;font-size:.75rem;opacity:.65;}',

            // —— AI 配置弹窗 ——
            '#nme-ai-cfg-modal{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.62);}',
            '#nme-ai-cfg-modal .nme-ai-modal{box-sizing:border-box;width:min(560px,92vw);max-height:88vh;overflow-y:auto;overflow-x:hidden;background:#1b1b1f;color:#eee;',
            '  border:1px solid rgba(255,255,255,.18);border-radius:.7rem;padding:1rem 1.1rem;box-shadow:0 10px 40px rgba(0,0,0,.55);}',
            '#nme-ai-cfg-modal .nme-ai-modal-title{font-weight:700;font-size:1rem;margin-bottom:.35rem;}',
            '#nme-ai-cfg-modal .nme-ai-modal-help{font-size:.78rem;line-height:1.6;opacity:.7;margin-bottom:.8rem;}',
            '#nme-ai-cfg-modal code{background:rgba(255,255,255,.1);padding:.05rem .3rem;border-radius:.2rem;}',
            '#nme-ai-cfg-modal .nme-ai-field{display:flex;flex-direction:column;gap:.25rem;margin-bottom:.6rem;}',
            '#nme-ai-cfg-modal .nme-cfg-section{font-weight:700;font-size:.82rem;margin:1rem 0 .55rem;padding-top:.65rem;border-top:1px solid rgba(255,255,255,.1);}',
            '#nme-ai-cfg-modal .nme-cfg-section:first-of-type{margin-top:.3rem;padding-top:0;border-top:none;}',
            '#nme-ai-cfg-modal .nme-cfg-row{display:flex;align-items:center;justify-content:space-between;gap:.6rem;margin-bottom:.5rem;}',
            '#nme-ai-cfg-modal .nme-cfg-label{font-size:.8rem;opacity:.8;}',
            '#nme-ai-cfg-modal .nme-cfg-num{width:7rem;padding:.35rem .5rem;border-radius:.4rem;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:inherit;font-size:.82rem;}',
            '#nme-ai-cfg-modal .nme-cfg-check{display:flex;align-items:center;gap:.45rem;font-size:.82rem;margin-bottom:.45rem;cursor:pointer;}',
            '#nme-ai-cfg-modal .nme-cfg-check input{width:1rem;height:1rem;accent-color:#d34a4a;cursor:pointer;margin:0;}',
            '#nme-ai-cfg-modal .nme-ai-field span{font-size:.78rem;opacity:.75;}',
            '#nme-ai-cfg-modal .nme-ai-field input{box-sizing:border-box;background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.22);',
            '  border-radius:.35rem;padding:.42rem .55rem;font-size:.85rem;}',
            '#nme-ai-cfg-modal .nme-ai-modal-foot{position:sticky;bottom:0;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-top:.85rem;padding-top:.7rem;background:#1b1b1f;border-top:1px solid rgba(255,255,255,.12);}',
            '#nme-ai-cfg-modal .nme-ai-modal-foot .nme-ai-status{flex:1;font-size:.78rem;}',
            '#nme-ai-cfg-modal .nme-ai-btn{background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.22);',
            '  border-radius:.375rem;padding:.35rem .8rem;font-size:.8125rem;cursor:pointer;}',
            '#nme-ai-cfg-modal .nme-ai-btn:hover{background:rgba(255,255,255,.16);}',
            '#nme-ai-cfg-modal .nme-ai-btn-accent{background:#d34a4a;border-color:#d34a4a;}',

            // —— 下载增强 ——
            '#nme-dl-bar{margin:1rem 0;padding:.8rem .95rem;border:1px solid rgba(255,255,255,.16);',
            '  border-radius:.6rem;background:rgba(255,255,255,.04);}',
            '#nme-dl-bar .nme-dl-head{display:flex;align-items:baseline;gap:.55rem;flex-wrap:wrap;}',
            '#nme-dl-bar .nme-dl-title{font-weight:700;color:#d34a4a;}',
            '#nme-dl-bar .nme-dl-sub{font-size:.75rem;opacity:.6;}',
            '#nme-dl-bar .nme-ai-status{font-size:.75rem;opacity:.7;}',
            '#nme-dl-bar .nme-dl-actions{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-top:.6rem;}',
            '#nme-dl-bar .nme-dl-btn{background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.16);',
            '  border-radius:.375rem;padding:.3rem .6rem;font-size:.8125rem;cursor:pointer;}',
            '#nme-dl-bar .nme-dl-btn:hover{background:rgba(255,255,255,.12);}',
            '#nme-dl-bar .nme-dl-btn:disabled{opacity:.5;cursor:not-allowed;}',
            '#nme-dl-bar .nme-dl-btn-accent{background:#d34a4a;border-color:#d34a4a;color:#fff;}',
            '#nme-dl-bar .nme-dl-gap{width:4.5rem;background:rgba(255,255,255,.06);color:inherit;',
            '  border:1px solid rgba(255,255,255,.16);border-radius:.375rem;padding:.25rem .4rem;font-size:.8125rem;}',
            '#nme-dl-bar .nme-dl-list{margin-top:.6rem;display:flex;flex-direction:column;gap:.35rem;max-height:22rem;overflow:auto;}',
            '#nme-dl-bar .nme-dl-row{display:flex;align-items:center;gap:.6rem;padding:.4rem .55rem;',
            '  border:1px solid rgba(255,255,255,.1);border-radius:.4rem;background:rgba(255,255,255,.02);}',
            '#nme-dl-bar .nme-dl-main{flex:1;min-width:0;}',
            '#nme-dl-bar .nme-dl-name{font-size:.875rem;font-weight:600;word-break:break-word;}',
            '#nme-dl-bar .nme-dl-meta{font-size:.75rem;opacity:.6;margin-top:.1rem;}',
            '#nme-dl-bar .nme-dl-opt{display:inline-flex;align-items:center;gap:.32rem;font-size:.75rem;opacity:.9;cursor:pointer;user-select:none;}',
            '#nme-dl-bar .nme-dl-opt input{width:.9rem;height:.9rem;accent-color:#d34a4a;cursor:pointer;margin:0;}',
            '#nme-dl-bar .nme-dl-opt input:disabled{cursor:not-allowed;opacity:.45;}',
            '#nme-dl-bar .nme-dl-tag{display:inline-block;font-size:.6875rem;border:1px solid currentColor;',
            '  border-radius:.2rem;padding:0 .25rem;margin-left:.35rem;opacity:.8;vertical-align:middle;}',
            '#nme-dl-bar .nme-dl-empty{font-size:.8125rem;opacity:.7;}',
            '#nme-dl-bar .nme-dl-err{color:#ff8a8a;opacity:1;}',
            '#nme-dl-bar .nme-dl-prog{height:6px;border-radius:3px;background:rgba(255,255,255,.12);',
            '  overflow:hidden;margin-top:.6rem;}',
            '#nme-dl-bar .nme-dl-prog-fill{height:100%;width:0;background:#d34a4a;transition:width .25s;}',
            '#nme-dl-bar .nme-dl-log{margin-top:.5rem;max-height:9rem;overflow:auto;font-size:.75rem;line-height:1.55;',
            '  background:rgba(0,0,0,.22);border-radius:.35rem;padding:.4rem .55rem;}',
            '#nme-dl-bar .nme-dl-log-err{color:#ff8a8a;}',
            '#nme-dl-bar .nme-dl-log-ok{color:#69c08a;}',
            '#nme-dl-bar .nme-dl-log-warn{color:#e0a33c;}'
        ].join('\n');
        GM_addStyle(css);
    }

    // ==================== 启动 ====================

    function nativeTileTemplate() {
        const t = nativeTiles()[0];
        return t || null;
    }

    /** 站点自己的卡片（排除增强视图里的） */
    function nativeTiles() {
        return $$('[data-e2eid="mod-tile"]').filter(function (t) {
            return !t.closest('#nme-grid');
        });
    }

    function countNative(root) {
        if (!root || !root.querySelectorAll) return 0;
        return Array.from(root.querySelectorAll('[data-e2eid="mod-tile"]')).filter(function (t) {
            return !t.closest('#nme-grid');
        }).length;
    }

    /**
     * 原生网格容器。
     * 列表页是 .mods-grid，搜索页是 div.grid.*，两者结构不同，
     * 所以从第一张原生卡片向上找「原生卡片数最多」的那一层，不写死类名。
     */
    function findNativeGrid() {
        const tiles = nativeTiles();
        if (!tiles.length) return null;
        let node = tiles[0].parentElement;
        let best = node;
        let bestCount = countNative(node);
        while (node && node !== document.body) {
            const c = countNative(node);
            if (c > bestCount) { bestCount = c; best = node; }
            node = node.parentElement;
        }
        return best;
    }

    /** 需要在增强视图下隐藏的原生结果根节点 */
    function nativeHideRoot(grid) {
        const p = grid && grid.parentElement;
        if (p && p.tagName === 'SECTION') return p;   // 搜索页：连同「模组 (N)」分组一起隐藏
        return grid;
    }

    /** React 重渲染会换掉原生网格节点，需要重新打上隐藏标记 */
    function ensureNativeHidden() {
        if (CFG.view !== 'enhanced') return;
        const grid = findNativeGrid();
        if (!grid) return;
        const root = nativeHideRoot(grid);
        if (root && root.getAttribute('data-nme-native') !== '1') {
            root.setAttribute('data-nme-native', '1');
        }
    }

    /**
     * 站点筛选面板里，分类/语言/标签这些行只有左边那个小方框可点，
     * 点文字没反应（HeadlessUI 的 role=checkbox 没有关联 label）。
     * 这里把文字点击转发给方框，属于「更高效的筛选」范畴。
     */
    function enhanceFilterClick() {
        const rows = $$('[class*="group/checkbox"]');
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.getAttribute('data-nme-click') === '1') continue;
            const cb = row.querySelector('[role=checkbox]');
            const label = row.querySelector('label');
            if (!cb || !label) continue;
            // 只有 label 指向真正的表单控件时，点击文字才会被浏览器转发；
            // Nexus 的 HeadlessUI 把 for 指向 <span role=checkbox>，浏览器不认，
            // 所以这里统一自己转发。
            const forId = label.getAttribute('for');
            const forEl = forId ? document.getElementById(forId) : null;
            const labelable = forEl && /^(INPUT|SELECT|TEXTAREA|BUTTON|METER|OUTPUT|PROGRESS)$/.test(forEl.tagName);
            if (labelable) continue;
            label.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                cb.click();
            });
            row.setAttribute('data-nme-click', '1');
        }
    }

    function mountEnhanced() {
        const ctx = state.ctx;
        if (!ctx) return;
        if ($('#nme-panel')) return;

        const tpl = nativeTileTemplate();
        if (!tpl) return; // 原生列表还没渲染出来，稍后重试
        state.tpl = tpl;

        const grid = findNativeGrid();
        if (!grid || !grid.parentElement) return;

        // 隐藏根节点：列表页 = 网格本身；搜索页 = 包含「模组 (N)」的 section
        const root = nativeHideRoot(grid);
        root.setAttribute('data-nme-native', '1');

        const panel = buildPanel(ctx);
        root.parentElement.insertBefore(panel, root);
        bindPanel(panel);

        setView(CFG.view);

        // 无限滚动
        const sentinel = $('#nme-sentinel');
        if (sentinel && window.IntersectionObserver) {
            state.io = new IntersectionObserver(function (entries) {
                for (let i = 0; i < entries.length; i++) {
                    if (entries[i].isIntersecting && !state.loading && !state.done) loadPage(false);
                }
            }, { rootMargin: '600px 0px' });
            state.io.observe(sentinel);
        }
    }

    function decorateNativeTiles(root) {
        if (!CFG.badges) return;
        const scope = root && root.querySelectorAll ? root : document;
        const tiles = scope.querySelectorAll('[data-e2eid="mod-tile"]');
        for (let i = 0; i < tiles.length; i++) {
            const tile = tiles[i];
            if (tile.closest('#nme-grid')) continue; // 增强视图的卡片自带徽章
            if (tile.getAttribute('data-nme-badged') === '1') continue;
            const title = tile.querySelector('[data-e2eid="mod-tile-title"]');
            if (!title) continue;
            const name = title.textContent || '';
            const badges = detectBadges({ name: name, tags: [] });
            if (!badges.length) { tile.setAttribute('data-nme-badged', '1'); continue; }
            const holder = document.createElement('span');
            holder.className = 'nme-badges';
            for (let j = 0; j < badges.length; j++) {
                const b = document.createElement('span');
                b.className = 'nme-badge ' + badges[j].cls;
                b.textContent = badges[j].text;
                holder.appendChild(b);
            }
            if (title.parentElement) title.parentElement.insertBefore(holder, title.nextSibling);
            tile.setAttribute('data-nme-badged', '1');
        }
    }

    /** 关闭徽章时清掉已插入的徽章，并重置标记，方便再次开启后重新装饰 */
    function clearBadges(root) {
        const scope = root && root.querySelectorAll ? root : document;
        $$('.nme-badges', scope).forEach(function (h) { h.remove(); });
        $$('[data-nme-badged]', scope).forEach(function (t) { t.removeAttribute('data-nme-badged'); });
    }

    // ==================== 下载历史更新检查 ====================
    // 站点「下载历史」页：模组更新时间晚于你的最后下载时间时，标橙并加「有更新」徽章。
    // 与同类脚本共存：不写内联样式（用 class + !important），不改表格结构，
    // 也不读写对方使用的「最后下载 / 更新时间」两列文本，徽章只插到首列末尾。

    const HIST_SEL = 'table.datatable';
    let histObs = null;
    let histTable = null;

    /** 表头是否同时具备「下载时间」与「更新时间」两列 */
    function histHasHeader(table) {
        const ths = $$('thead th', table);
        if (!ths.length) return false;
        let dl = false, up = false;
        for (let i = 0; i < ths.length; i++) {
            const t = (ths[i].textContent || '').trim();
            if (/(last\s*)?downloaded|下载时间|最后下载/i.test(t)) dl = true;
            if (/(last\s*)?updated|file\s*updated|更新时间|最近更新/i.test(t)) up = true;
        }
        return dl && up;
    }

    function isDownloadHistoryPage() {
        if (!/\/users\/myaccount/i.test(location.pathname)) return false;
        const table = $(HIST_SEL);
        if (!table) return false;
        const tab = new URLSearchParams(location.search).get('tab') || '';
        return /download/i.test(tab) || histHasHeader(table);
    }

    const HIST_MONTHS = {
        jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
        jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
    };

    /** 兼容 "12 November 2024, 3:45PM" / "Nov 12 2024" / "2024-11-12" */
    function parseHistText(txt) {
        const s = String(txt || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
        if (!s) return null;
        const quick = new Date(s);
        if (isFinite(quick.getTime())) return quick;
        const m = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);
        if (m) {
            const mon = HIST_MONTHS[m[2].slice(0, 3).toLowerCase()];
            if (mon !== undefined) {
                const time = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/);
                let hh = time ? Number(time[1]) : 0;
                const mm = time ? Number(time[2]) : 0;
                if (time && time[4]) {
                    const pm = /p/i.test(time[4]);
                    if (pm && hh < 12) hh += 12;
                    if (!pm && hh === 12) hh = 0;
                }
                const d = new Date(Number(m[3]), mon, Number(m[1]), hh, mm);
                return isFinite(d.getTime()) ? d : null;
            }
        }
        return null;
    }

    /** 优先取 data-sort 时间戳，其次解析单元格文本 */
    function histDate(td) {
        if (!td) return null;
        const raw = (td.getAttribute('data-sort') || td.getAttribute('data-date') || '').trim();
        if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000);
        if (/^\d{13}$/.test(raw)) return new Date(Number(raw));
        if (raw) {
            const d = new Date(raw);
            if (isFinite(d.getTime())) return d;
        }
        return parseHistText(td.textContent);
    }

    /** 表头识别列；识别失败时退回旧站惯例（1=最后下载，4=更新时间） */
    function histColumns(table) {
        const ths = $$('thead th', table);
        if (!ths.length) return { dl: 1, up: 4 };
        const idxOf = function (re) {
            for (let i = 0; i < ths.length; i++) {
                if (re.test((ths[i].textContent || '').trim())) return i;
            }
            return -1;
        };
        const dl = idxOf(/(last\s*)?downloaded|下载时间|最后下载/i);
        const up = idxOf(/(last\s*)?updated|file\s*updated|更新时间|最近更新/i);
        return (dl >= 0 && up >= 0) ? { dl: dl, up: up } : { dl: 1, up: 4 };
    }

    function ensureHistBar(table) {
        let bar = $('#nme-hist-bar');
        if (bar) return bar;
        if (!table.parentElement) return null;
        bar = document.createElement('div');
        bar.id = 'nme-hist-bar';
        bar.innerHTML = '<div class="nme-hist-head"><b>下载历史更新检查</b><span id="nme-hist-count">检查中…</span></div>' +
            '<button id="nme-hist-only" type="button">只看有更新</button>' +
            '<button id="nme-hist-recheck" type="button">重新检查</button>' +
            '<div class="nme-hist-tip">橙色 = 模组更新时间晚于你的最后下载时间</div>';
        table.parentElement.insertBefore(bar, table);

        const only = $('#nme-hist-only', bar);
        const recheck = $('#nme-hist-recheck', bar);
        if (only) {
            only.addEventListener('click', function () {
                state.histOnly = !state.histOnly;
                only.textContent = state.histOnly ? '显示全部' : '只看有更新';
                const t = $(HIST_SEL);
                if (t) t.classList.toggle('nme-hist-only', state.histOnly);
            });
        }
        if (recheck) {
            recheck.addEventListener('click', function () {
                scanHistory();
                showToast('下载历史检查完成', $('#nme-hist-count') ? $('#nme-hist-count').textContent : '', 'enhanced');
            });
        }
        return bar;
    }

    function scanHistory() {
        const table = $(HIST_SEL);
        if (!table) return;
        const cols = histColumns(table);
        const rows = $$('tbody tr', table);
        const minCells = Math.max(cols.dl, cols.up) + 1;
        let updates = 0;

        rows.forEach(function (row) {
            const cells = row.children;
            if (!cells || cells.length < minCells) return;
            const dl = histDate(cells[cols.dl]);
            const up = histDate(cells[cols.up]);
            const isUpd = !!(dl && up && up.getTime() > dl.getTime());

            row.classList.toggle('nme-hist-row', isUpd);
            const first = cells[0];
            const badge = first ? first.querySelector('.nme-hist-badge') : null;
            if (isUpd) {
                updates++;
                row.setAttribute('data-nme-upd', '1');
                // 同类脚本可能已经给首列加了内联左边框，避免出现两条竖线
                if (first) row.classList.toggle('nme-hist-noedge', !!(first.style && first.style.borderLeftWidth));
                if (first && !badge) {
                    const b = document.createElement('span');
                    b.className = 'nme-hist-badge';
                    b.textContent = '有更新';
                    first.appendChild(b);
                }
            } else {
                row.removeAttribute('data-nme-upd');
                if (badge) badge.remove();
            }
        });

        const count = $('#nme-hist-count');
        if (count) {
            const now = new Date();
            const hh = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
            const text = '共 ' + rows.length + ' 条 · ' + updates + ' 个有更新 · ' + hh;
            // 内容没变就不写，避免自身触发的 MutationObserver 反复扫描
            if (count.textContent !== text) count.textContent = text;
        }
        return updates;
    }

    function mountHistoryCheck() {
        if (!isDownloadHistoryPage()) return false;
        const table = $(HIST_SEL);
        if (!table) return false;
        ensureHistBar(table);
        if (state.histOnly) table.classList.add('nme-hist-only');

        // 表被 React 重绘后需要重新挂钩
        if (histTable !== table) {
            if (histObs) histObs.disconnect();
            histTable = table;
            histObs = new MutationObserver(debounce(function () { scanHistory(); }, 300));
            histObs.observe(table, { childList: true, subtree: true });
        }
        scanHistory();
        return true;
    }


    // 菜单项要能反映当前状态，所以每次变更后反注册再注册。
    // 个别管理器不返回菜单 id，此时退化为只注册一次，避免菜单堆叠。
    const CAN_UNREG_MENU = typeof GM_unregisterMenuCommand === 'function';
    let menuIds = [];
    let menuRegistered = false;
    let menuRefreshable = CAN_UNREG_MENU;

    function refreshMenu() {
        if (!menuRefreshable) return;
        // 异步重建：避免在菜单回调里同步反注册正在执行的那一条
        setTimeout(function () { setupMenu(); }, 0);
    }

    function setupMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        if (menuRegistered && !menuRefreshable) return;
        try {
            if (CAN_UNREG_MENU) {
                for (let i = 0; i < menuIds.length; i++) {
                    try { GM_unregisterMenuCommand(menuIds[i]); } catch (e) { /* 忽略单个失败 */ }
                }
            }
            menuIds = [];
            const reg = function (label, fn) {
                const id = GM_registerMenuCommand(label, fn);
                if (id === undefined || id === null) menuRefreshable = false;
                else menuIds.push(id);
            };

            const enhanced = CFG.view === 'enhanced';
            reg(enhanced ? '视图：增强视图（点击切到原生）' : '视图：原生视图（点击切到增强）', function () {
                setView(CFG.view === 'enhanced' ? 'native' : 'enhanced');
            });

            [20, 40, 60, 80].forEach(function (n) {
                reg('每页条数：' + n + (CFG.pageSize === n ? ' ✓' : ''), function () {
                    CFG.pageSize = n;
                    saveCfg();
                    refreshCapsule();
                    refreshMenu();
                    const isList = state.ctx && (state.ctx.mode === 'list' || state.ctx.mode === 'search');
                    if (CFG.view !== 'enhanced') {
                        showToast('每页条数：' + n, '当前为原生视图，切回增强视图后生效', 'native');
                    } else if (isList) {
                        showToast('每页条数：' + n, '正在重新加载列表…', 'enhanced');
                        loadPage(true);
                    } else {
                        // 详情页/合集页没有列表上下文，避免直接调用 loadPage
                        showToast('每页条数：' + n, '回到列表或搜索页后生效', 'enhanced');
                    }
                });
            });

            reg('界面中文化：' + (CFG.zhUI ? '开 ✓' : '关'), function () {
                CFG.zhUI = !CFG.zhUI;
                saveCfg();
                refreshMenu();
                if (CFG.zhUI) {
                    translateTree(document.body);
                    showToast('界面中文化：已开启', '站点界面文本已替换为中文', 'enhanced');
                } else {
                    showToast('界面中文化：已关闭', '已翻译的文本需刷新页面才会恢复英文', 'native');
                }
            });

            reg('语言徽章：' + (CFG.badges ? '开 ✓' : '关'), function () {
                CFG.badges = !CFG.badges;
                saveCfg();
                refreshMenu();
                if (!CFG.badges) {
                    clearBadges(document.body);
                    showToast('语言徽章：已关闭', '已移除当前页面上的徽章', 'native');
                    return;
                }
                const isList = state.ctx && (state.ctx.mode === 'list' || state.ctx.mode === 'search');
                if (CFG.view === 'enhanced' && isList && $('#nme-grid')) {
                    // 增强视图的卡片徽章由 makeTile 生成，重新渲染才能补上
                    loadPage(true);
                    showToast('语言徽章：已开启', '正在重新渲染卡片…', 'enhanced');
                } else {
                    decorateNativeTiles(document.body);
                    showToast('语言徽章：已开启', '已为当前卡片添加徽章', 'enhanced');
                }
            });

            reg('下载等待页自动跳过：' + (CFG.skipWait ? '开 ✓' : '关'), function () {
                CFG.skipWait = !CFG.skipWait;
                saveCfg();
                refreshMenu();
                showToast('下载等待页自动跳过：' + (CFG.skipWait ? '开' : '关'),
                    CFG.skipWait ? '下次进入下载等待页时自动跳转' : '下次进入下载等待页时保持原样', 'enhanced');
            });

            reg('归档下载：自测能否自动建文件夹', runArchiveSelfTest);

            reg('下载历史：重新检查更新', function () {
                if (mountHistoryCheck()) {
                    showToast('下载历史：已重新检查', $('#nme-hist-count') ? $('#nme-hist-count').textContent : '', 'enhanced');
                } else {
                    showToast('下载历史：请先打开下载历史页', '路径为 /users/myaccount?tab=downloads', 'native');
                }
            });

            reg('脚本设置（下载 / 界面 / AI）', function () { openSettings('download'); });

            menuRegistered = true;
        } catch (e) { /* 忽略 */ }
    }

    function init() {
        sanitizeCfg();
        addStyle();
        setupMenu();

        // 下载等待页：尽早开始等待按钮
        setupDownloadSkip();

        // 页面切到后台时主动中止当前下载请求：
        // 等浏览器冻结页面再断，fetch 会以「网络错误」收场；主动断则断点齐整，回前台能接着下。
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) dlAbortCurrentFetch();
        });

        const ctx = getContext();
        state.ctx = ctx;

        // React 站点（Next.js）服务端渲染英文文本后再水合。
        // 在水合提交前改写文本或插入节点，都会让 React 判定「服务端与客户端不一致」，
        // 抛出 #418 并把整棵树改成客户端重渲染 —— 我们的中文会被冲掉。
        // 所以 React 页面统一推迟到水合提交后再动手。
        state.reactApp = detectReactApp();

        if (state.reactApp) {
            waitHydration(function () { bootUi(ctx); });
        } else {
            bootUi(ctx);
        }

        console.log('%c' + LOG_PREFIX + ' v' + VERSION + ' 已启动', 'color:#d34a4a;font-weight:bold;font-size:13px');
    }

    /** 水合完成后（或非 React 站点立即）挂载界面 */
    function bootUi(ctx) {
        // 右下角浮动胶囊（所有页面常驻，不依赖增强视图面板）
        mountCapsule();

        if (CFG.zhUI) translateTree(document.body);
        enhanceFilterClick();

        if (ctx) {
            if (ctx.mode === 'detail') {
                // 模组详情页：浮动按钮坞（AI / 下载）
                mountFab(ctx);
                let tries = 0;
                const tryMountAi = function () {
                    tries++;
                    mountDetailAi(ctx);
                    mountDetailDownload(ctx);
                    if ((!$('#nme-ai-bar') || !$('#nme-dl-bar')) && tries < 40) setTimeout(tryMountAi, 250);
                };
                tryMountAi();
            } else if (ctx.mode === 'collection') {
                // 合集页：浮动按钮坞 + 批量下载面板
                mountFab(ctx);
                let tries = 0;
                const tryMountColl = function () {
                    tries++;
                    if ($('#nme-dl-bar')) return;
                    mountCollectionDownload(ctx);
                    if (!$('#nme-dl-bar') && tries < 40) setTimeout(tryMountColl, 250);
                };
                tryMountColl();
            } else {
                // 等原生列表渲染出第一张卡片再挂载增强视图（需要克隆原生卡片做样式模板）
                let tries = 0;
                const tryMount = function () {
                    tries++;
                    if ($('#nme-panel')) return;
                    mountEnhanced();
                    if (!$('#nme-panel') && tries < 40) setTimeout(tryMount, 250);
                };
                tryMount();
            }
        }

        if (!ctx) {
            // 下载历史页：表是异步渲染的，等它出现
            let triesHist = 0;
            const tryHist = function () {
                triesHist++;
                if (mountHistoryCheck()) return;
                if (triesHist < 40 && /\/users\/myaccount/i.test(location.pathname)) setTimeout(tryHist, 250);
            };
            tryHist();
        }

        // 站点是 React 客户端渲染，后续内容需要持续处理（中文化 + 徽章 + 详情页 AI 条）
        const obs = new MutationObserver(debounce(function () {
            // 水合提交后再扫一遍：之前被跳过的文本这时才允许改写
            if (state.reactApp && !state.hydrated) {
                if (!reactHydrated()) return;
                state.hydrated = true;
            }
            if (CFG.zhUI) translateTree(document.body);
            if (CFG.badges) decorateNativeTiles(document.body);
            enhanceFilterClick();
            if (state.ctx && state.ctx.mode === 'detail') {
                mountDetailAi(state.ctx);
                mountDetailDownload(state.ctx);
            } else if (state.ctx && state.ctx.mode === 'collection') {
                mountCollectionDownload(state.ctx);
            } else {
                ensureNativeHidden();
                if (isDownloadHistoryPage()) mountHistoryCheck();
            }
        }, 250));
        try { obs.observe(document.body, { childList: true, subtree: true }); } catch (e) { /* 忽略 */ }
    }

    /**
     * 等待 React 水合提交。
     * 超时（站点并非 React 水合，或标记始终没出现）也放行，
     * 此时按「没有服务端文本需要比对」处理，直接执行。
     */
    function waitHydration(done) {
        let tries = 0;
        const iv = setInterval(function () {
            tries++;
            if (reactHydrated()) {
                clearInterval(iv);
                state.hydrated = true;
                done(true);
                return;
            }
            if (tries >= 60) {
                clearInterval(iv);
                // 没等到 React 标记：可能压根不是 React 站点，直接放行
                state.hydrated = true;
                done(false);
            }
        }, 150);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
