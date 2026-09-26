/**
 * highlight-verify.mjs —— 页面高亮 class 污染验证脚本
 *
 * 【要验证的缺陷】
 * 两个同构的 Chrome DevTools 扩展（360-XPath-Tool 与 Css-Selector-Tool）在页面侧都做两件事：
 *   1. 给命中节点打一个高亮 class（XPath 版 chromexPathFinder，CSS 版 chromecssSelectorFinder）；
 *   2. 把选择器 / 表达式写进面板的路径框。
 * 如果第 2 步在生成表达式时直接读元素的 class 属性，就会把第 1 步刚打上去的高亮 class
 * 一起写进表达式。用户看到的现象是：点一次「智能 / 原始」后路径框里多出一段
 * `[@class='item chromexPathFinder']`，等高亮被清掉，这个表达式就再也匹配不到任何节点。
 *
 * 【验证方法】
 * 用 linkedom 构造真实 DOM，把 content/content.js 原样塞进 node:vm 沙箱执行，
 * 完整模拟「右键 → 生成表达式 → 求值并高亮 → 再点智能/原始重新生成 → 清高亮」这条链路。
 * 关键断言是"重新生成时表达式里不能出现高亮 class"，以及"清掉高亮后先前生成的表达式必须仍能命中"。
 *
 * 【用法】
 *   node tests/highlight-verify.mjs
 * 全部通过时进程退出码 0，任一用例失败退出码 1。
 *
 * 【依赖】
 * linkedom + xpath，装在工作区根目录的 node_modules 里；
 * 两个扩展项目本身仍然保持零依赖、无构建步骤。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseHTML } = require('linkedom');
const xpathLib = require('xpath');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_JS = path.join(HERE, '..', 'content', 'content.js');

////////////////////////////////////////////////////////////////////////////////
// 测试夹具：一棵覆盖各种边界情况的真实 DOM
////////////////////////////////////////////////////////////////////////////////

/**
 * 构造被测页面。
 *
 * 刻意让大部分元素**不带 id**：XPath 版只有在元素没有 id 时才会走 `[@class='...']` 分支，
 * 如果夹具元素全都带 id，高亮污染这条路径根本走不到，测试会假绿。
 *
 * 覆盖点：无 id 单 class、无 id 多 class、带 id、多个同类兄弟（验证位置序号）、
 *         SVG 元素（验证 className 不是字符串的坑）、img（XPath 版有 /@src 特例）。
 * @returns {string} 完整 HTML 文本
 */
function buildFixtureHtml() {
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head><title>highlight fixture</title></head>',
    '<body>',
    '  <div class="plain">plain</div>',
    '  <div class="solo">single</div>',
    '  <div class="alpha beta">multi</div>',
    '  <div id="byid" class="tagged">by id</div>',
    '  <ul class="list">',
    '    <li class="item">L1</li>',
    '    <li class="item">L2</li>',
    '    <li class="item">L3</li>',
    '  </ul>',
    '  <div class="holder">',
    '    <svg class="icon" width="20" height="20">',
    '      <circle class="shape" cx="5" cy="5" r="4"></circle>',
    '    </svg>',
    '  </div>',
    '  <img class="pic" src="pic.png">',
    '</body>',
    '</html>'
  ].join('\n');
}

////////////////////////////////////////////////////////////////////////////////
// 变体识别：同一份脚本同时服务 XPath 版与 CSS 版
////////////////////////////////////////////////////////////////////////////////

/**
 * 通过 content.js 源码判断当前项目是哪个变体，并给出各自的命名空间、
 * 高亮 class 名、右键命令名、以及回传消息里承载表达式的字段名。
 * @returns {{kind:string, ns:string, highlightClass:string, getCmd:string, field:string, transformField:string}} 变体描述
 */
function detectFlavor() {
  const src = fs.readFileSync(CONTENT_JS, 'utf8');
  // 必须匹配"命名空间.函数名 ="的赋值形式。用裸函数名会被注释里的引用误导 ——
  // CSS 版的注释中就提到了 XPath 版的 makeQueryForElement。
  if (src.indexOf('xh.makeQueryForElement =') !== -1) {
    return {
      kind: 'xpath',
      ns: 'xh',
      highlightClass: 'chromexPathFinder',
      getCmd: 'getXPath',
      field: 'query',
      transformField: 'query'
    };
  }
  if (src.indexOf('sh.makeSelectorForElement =') !== -1) {
    return {
      kind: 'css',
      ns: 'sh',
      highlightClass: 'chromecssSelectorFinder',
      getCmd: 'getSelector',
      field: 'selector',
      transformField: 'selector'
    };
  }
  throw new Error('无法识别的 content.js 变体：既没有 makeQueryForElement 也没有 makeSelectorForElement');
}

////////////////////////////////////////////////////////////////////////////////
// 沙箱环境
////////////////////////////////////////////////////////////////////////////////

/**
 * CSS.escape 的最小可用实现。linkedom 不提供 CSS 对象，
 * 而 content.js 的 id/class 转义依赖它，缺失会直接抛异常。
 * @param {string} value 待转义的标识符
 * @returns {string} 转义后的标识符
 */
function cssEscape(value) {
  const str = String(value);
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const ch = str.charAt(i);
    // 数字开头必须转义，否则会被当成选择器里的数字
    if (code === 0x0000) {
      out += '�';
    } else if (
      (code >= 0x0001 && code <= 0x001f) || code === 0x007f ||
      (i === 0 && code >= 0x0030 && code <= 0x0039) ||
      (i === 1 && code >= 0x0030 && code <= 0x0039 && str.charAt(0) === '-')
    ) {
      out += '\\' + code.toString(16) + ' ';
    } else if (code === 0x002d || code === 0x005f ||
               (code >= 0x0030 && code <= 0x0039) ||
               (code >= 0x0041 && code <= 0x005a) ||
               (code >= 0x0061 && code <= 0x007a) ||
               code >= 0x0080) {
      out += ch;
    } else {
      out += '\\' + ch;
    }
  }
  return out;
}

/**
 * 给 linkedom 的 document 补一个 document.evaluate。
 * linkedom 完全不实现 XPath，这里用纯 JS 的 xpath 库顶上。
 *
 * 两个必须处理的点：
 * 1. 强制打开"无前缀名测试允许任意命名空间"与"大小写不敏感"两个开关 ——
 *    前者是因为 HTML 元素带 XHTML 命名空间，不开这个开关 `//div` 一条都匹配不到；
 *    后者是因为 XPath 名字测试默认大小写敏感，而 HTML 标签名不敏感。
 *    注意 evaluate() 内部会重算 caseInsensitive，所以这个开关只能靠 detectHtmlDom 生效。
 * 2. 必须把调用方传入的 resultType 透传下去。content.js 解析表达式时用的是
 *    FIRST_ORDERED_NODE_TYPE，结果对象上才有 singleNodeValue；
 *    一律按 ANY_TYPE 返回的话，调用方拿到的就是迭代器结果，singleNodeValue 为 undefined。
 * @param {object} document linkedom 文档对象
 * @returns {object} 可直接赋给 document.evaluate 的函数
 */
function makeEvaluateShim(document) {
  return function evaluate(expression, contextNode, resolver, type, result) {
    const expr = xpathLib.createExpression(expression);
    expr.context.caseInsensitive = true;
    expr.context.allowAnyNamespaceForNoPrefix = true;
    // 调用方没给或给了 ANY_TYPE 时才让库自己推断结果类型
    const wantType = (type === undefined || type === null ||
      type === xpathLib.XPathResult.ANY_TYPE)
      ? xpathLib.XPathResult.ANY_TYPE
      : type;
    return expr.evaluate(contextNode || document, wantType, null);
  };
}

/**
 * 给 getElementsByClassName 套一个"实时"视图。
 *
 * 真实浏览器规范保证 getElementsByClassName 返回 live HTMLCollection，
 * 而 linkedom 返回的是一次性快照。旧版 clearHighlights 恰好依赖 liveness：
 *
 *   var els = document.getElementsByClassName(H);
 *   while (els.length) { els[0].className = els[0].className.replace(' ' + H, ''); }
 *
 * 快照语义下 els.length 永远不变，这个 while 会死循环把整个测试进程挂住。
 * 这里用 Proxy 把它还原成 live 语义，测试才跑得完。
 * 注意：这只是让套件能继续跑，真实浏览器里本来就是 live 的，不算被测代码的缺陷。
 * @param {object} document linkedom 文档对象
 * @returns {Function} 替换用的 getElementsByClassName
 */
function installLiveClassList(document) {
  return function getElementsByClassName(className) {
    // 每次访问都重新查一遍，从而反映当前真实状态
    const live = () => document.querySelectorAll('.' + className);
    return new Proxy([], {
      get(_target, prop) {
        const nodes = live();
        if (prop === 'length') {
          return nodes.length;
        }
        if (prop === 'item') {
          return (i) => nodes[i] || null;
        }
        if (prop === Symbol.iterator) {
          return function* iterate() {
            yield* nodes;
          };
        }
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          return nodes[Number(prop)];
        }
        return undefined;
      },
      // 必须实现 has 陷阱：Array.prototype.slice 内部是
      // 「读 length → 逐个 HasProperty → 再 Get」的流程，
      // 缺了 has 就会把每个下标都判成不存在，slice 出来的数组全是 undefined。
      // 被测代码里 clearHighlights 正是用 slice.call 做快照的。
      has(_target, prop) {
        return typeof prop === 'string' && /^\d+$/.test(prop) && Number(prop) < live().length;
      }
    });
  };
}

/**
 * 强行按 childNodes 的真实顺序补齐 firstChild / nextSibling / previousSibling。
 *
 * 这是 linkedom 的另一个怪癖，同样不是被测代码的缺陷：
 * linkedom 的 Document 上，doctype 节点的 nextSibling 是 undefined，
 * 于是 `firstChild → nextSibling` 这条链在 doctype 处就断了。
 * 而 xpath 库的子轴、兄弟轴、后裔轴**只**走 firstChild/nextSibling，
 * 链一断，`/html`、`//li` 这类表达式就一条都匹配不到，测试会误以为表达式本身失效。
 * 真实浏览器里 DOM 的兄弟指针是规范保证的，不存在这个问题，所以只在这里补齐。
 * @param {object} root 遍历起点
 * @returns {void}
 */
function hardenSiblingLinks(root) {
  const define = (node, prop, value) => {
    if (node[prop] === value) {
      return;
    }
    try {
      Object.defineProperty(node, prop, { value: value, configurable: true, writable: true });
    } catch (e) {
      // 属性不可重定义就保持原样，不影响其余链接
    }
  };

  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    const kids = node.childNodes;
    if (!kids || kids.length === 0) {
      continue;
    }
    let prev = null;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      stack.push(child);
      define(child, 'previousSibling', prev);
      define(child, 'nextSibling', i + 1 < kids.length ? kids[i + 1] : null);
      define(child, 'parentNode', node);
      prev = child;
    }
    define(node, 'firstChild', kids[0]);
    define(node, 'lastChild', kids[kids.length - 1]);
  }
}

/**
 * 清掉 content.js 的"防重复注入"守卫标记。
 *
 * 必须这么做的原因是 linkedom 的怪癖，不是被测代码的缺陷：
 * linkedom 每次 parseHTML 返回的 window 虽然不是同一个对象，但给 window 挂自定义属性
 * 实际写进了它内部的共享全局对象。于是第二次建沙箱时 `__cssSelectorFinderMessageBound`
 * 已经是 true，content.js 会跳过注册 onMessage 监听器，测试就会误报"没注册监听器"。
 * 真实浏览器里每个页面有独立的 window，不存在这个问题，所以只在这里重置。
 * @param {object} window linkedom window 对象
 * @returns {void}
 */
function resetInjectionGuards(window) {
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key.indexOf('__') === 0 && /MouseBound|MessageBound$/.test(key)) {
      delete window[key];
    }
  }
}

/**
 * 构建一个已装载 content.js 的沙箱，返回操作句柄。
 * @param {object} flavor 变体描述
 * @returns {{window:object, document:object, sandbox:object, listeners:Array, sent:Array, logs:Array}} 沙箱句柄
 */
function createSandbox(flavor) {
  const { window, document, Node } = parseHTML(buildFixtureHtml());

  // linkedom 的 window 属性跨实例共享，装载前先清干净上一条用例留下的守卫标记
  resetInjectionGuards(window);
  // linkedom 的兄弟指针在 doctype 处断裂，补齐后 xpath 的各条轴才走得通
  hardenSiblingLinks(document);
  // linkedom 的 getElementsByClassName 返回静态快照，还原成 live 语义（详见函数注释）
  document.getElementsByClassName = installLiveClassList(document);

  // linkedom 缺 CSS.escape，补上；缺 document.evaluate / XPathResult，按变体补上
  const CSS = { escape: cssEscape };
  if (flavor.kind === 'xpath') {
    document.evaluate = makeEvaluateShim(document);
    window.document = document;
  }

  // 记录 content.js 注册的消息监听器与发往 background 的消息
  const listeners = [];
  const sent = [];
  const logs = [];

  // 静默 console：content.js 打印量很大，只在失败时回放
  const consoleStub = {
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push('[warn] ' + args.join(' ')),
    error: (...args) => logs.push('[error] ' + args.join(' '))
  };

  const chromeStub = {
    runtime: {
      onMessage: {
        addListener: (fn) => listeners.push(fn)
      },
      sendMessage: (message, callback) => {
        sent.push(message);
        if (typeof callback === 'function') {
          callback({ status: 'ok' });
        }
      },
      lastError: null
    }
  };

  const sandbox = {
    window,
    document,
    Node,
    CSS,
    console: consoleStub,
    chrome: chromeStub
  };
  if (flavor.kind === 'xpath') {
    sandbox.XPathResult = xpathLib.XPathResult;
  }

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CONTENT_JS, 'utf8'), sandbox, { filename: CONTENT_JS });

  return { window, document, sandbox, listeners, sent, logs };
}

/**
 * 向 content.js 投递一条它已注册监听的消息，等价于 background 转发过来的指令。
 * @param {object} env createSandbox 返回的句柄
 * @param {object} message 消息体
 * @returns {void}
 */
function deliver(env, message) {
  if (env.listeners.length === 0) {
    throw new Error('content.js 没有注册 chrome.runtime.onMessage 监听器');
  }
  for (const fn of env.listeners) {
    fn(message, { id: 'fake-tab' }, () => {});
  }
}

/**
 * 模拟用户在该元素上右键，从而让 content.js 的 mousedown 捕获逻辑记下目标元素。
 * @param {object} env createSandbox 返回的句柄
 * @param {Element} target 被右键的元素
 * @returns {void}
 */
function simulateRightClick(env, target) {
  target.dispatchEvent(new env.window.Event('mousedown', { bubbles: true }));
}

/**
 * 取最后一条 update 消息里承载表达式的字段。
 * @param {object} env createSandbox 返回的句柄
 * @param {object} flavor 变体描述
 * @returns {string} 表达式文本
 */
function lastExpression(env, flavor) {
  if (env.sent.length === 0) {
    throw new Error('content.js 没有发出任何 update 消息');
  }
  const last = env.sent[env.sent.length - 1];
  const value = last[flavor.field];
  return typeof value === 'string' ? value : '';
}

/**
 * 把生成的表达式喂回引擎，统计命中数。
 * 表达式非法时不让异常冒泡，而是返回 count = -1 并带上原因 ——
 * "表达式非法"本身就是被测缺陷的一种表现，必须作为断言失败报出来，而不是让脚本崩掉。
 * @param {object} env createSandbox 返回的句柄
 * @param {object} flavor 变体描述
 * @param {string} expression 待求值的表达式
 * @returns {{count:number, first:object|null, error:string}} 命中数量、第一个命中节点、错误原因
 */
function evaluateExpression(env, flavor, expression) {
  if (!expression) {
    return { count: -1, first: null, error: '表达式为空' };
  }
  try {
    if (flavor.kind === 'css') {
      const nodes = env.document.querySelectorAll(expression);
      return { count: nodes.length, first: nodes.length ? nodes[0] : null, error: '' };
    }
    const result = env.document.evaluate(
      expression, env.document, null, xpathLib.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    const count = result.snapshotLength;
    return { count: count, first: count ? result.snapshotItem(0) : null, error: '' };
  } catch (e) {
    return { count: -1, first: null, error: e.message };
  }
}

////////////////////////////////////////////////////////////////////////////////
// 用例定义
////////////////////////////////////////////////////////////////////////////////

/**
 * 被测目标元素清单。
 * 刻意不按 id 取元素：XPath 版有 id 时走 `[@id='...']` 分支，绕开了 class 污染路径。
 * @returns {Array<{name:string, pick:Function, expectAttr:boolean}>} 用例定义
 */
function buildCases() {
  const nth = (selector, index) => (d) => d.querySelectorAll(selector)[index];
  return [
    { name: '无 id 单 class 的 div', pick: nth('.plain', 0), expectAttr: false },
    { name: '无 id 另一个 class 的 div', pick: nth('.solo', 0), expectAttr: false },
    { name: '无 id 多 class 的 div', pick: nth('.alpha', 0), expectAttr: false },
    { name: '有 id 的 div（走 id 分支）', pick: nth('#byid', 0), expectAttr: false },
    { name: '同类兄弟第 1 个 li', pick: nth('li.item', 0), expectAttr: false },
    { name: '同类兄弟第 2 个 li', pick: nth('li.item', 1), expectAttr: false },
    { name: '同类兄弟第 3 个 li', pick: nth('li.item', 2), expectAttr: false },
    { name: 'SVG 圆', pick: nth('circle', 0), expectAttr: false },
    { name: 'SVG 根节点', pick: nth('svg', 0), expectAttr: false },
    { name: 'img（XPath 版有 /@src 特例）', pick: nth('img', 0), expectAttr: true }
  ];
}

////////////////////////////////////////////////////////////////////////////////
// 断言与执行
////////////////////////////////////////////////////////////////////////////////

const results = [];

/**
 * 统计当前页面上带高亮 class 的元素个数。
 * 刻意走 querySelectorAll 而不是 getElementsByClassName ——
 * 后者在沙箱里被换成了 live 视图，测试自己不该依赖被测环境的行为。
 * @param {object} env createSandbox 返回的句柄
 * @param {object} flavor 变体描述
 * @returns {number} 带高亮 class 的元素数
 */
function countHighlighted(env, flavor) {
  return env.document.querySelectorAll('.' + flavor.highlightClass).length;
}

/**
 * 记录一条用例的执行结果。
 * @param {string} caseName 用例名
 * @param {string} probeName 断言名
 * @param {boolean} ok 是否通过
 * @param {string} detail 失败时的补充说明
 * @returns {void}
 */
function record(caseName, probeName, ok, detail) {
  results.push({ caseName: caseName, probeName: probeName, ok: ok, detail: detail || '' });
}

/**
 * 检查一段文本里是否混入了高亮 class。
 * @param {string} text 待检查文本
 * @param {string} highlightClass 高亮 class 名
 * @returns {boolean} 命中即返回 true
 */
function containsHighlightClass(text, highlightClass) {
  return String(text).indexOf(highlightClass) !== -1;
}

/**
 * 跑完一个元素目标的全部断言。
 *
 * 链路：右键生成 → （此时元素已被高亮）点「原始」重新生成 → 点「智能」重新生成
 *      → 清高亮 → 回头验证先前生成的表达式是否仍能命中。
 * @param {object} flavor 变体描述
 * @param {object} item 用例定义
 * @returns {void}
 */
function runCase(flavor, item) {
  const caseName = item.name;
  const env = createSandbox(flavor);
  const target = item.pick(env.document);

  // 夹具写错时的自检：目标元素必须真的取到
  if (!target) {
    record(caseName, '夹具能取到目标元素', false, 'pick 返回 null');
    return;
  }

  // ---- 右键生成初始表达式（此时元素尚未高亮）----
  simulateRightClick(env, target);
  deliver(env, { command: flavor.getCmd });
  const initial = lastExpression(env, flavor);

  // 表达式都没生成出来就没什么可测的了，记一条失败后跳过本用例的其余断言，
  // 这样后面的用例还能继续跑，一次性把全部缺陷暴露出来而不是卡在第一个。
  if (!initial) {
    record(caseName, '右键能生成出表达式', false,
      'content.js 回传为空；沙箱日志: ' + env.logs.join(' | '));
    return;
  }

  if (item.expectAttr) {
    // XPath 版对 img 会追加 /@src，命中的是属性节点而不是元素本身
    if (flavor.kind === 'xpath') {
      record(caseName, 'img 生成表达式带 /@src', initial.indexOf('/@src') !== -1,
        '实际生成: ' + initial);
      const attrResult = evaluateExpression(env, flavor, initial);
      // 属性节点的取值：规范要求 nodeValue 有效，但 linkedom 只给 value，两个都认
      const attrValue = attrResult.first
        ? (attrResult.first.nodeValue !== null && attrResult.first.nodeValue !== undefined
            ? attrResult.first.nodeValue
            : attrResult.first.value)
        : null;
      record(caseName, 'img 表达式命中 src 属性',
        attrResult.count === 1 && attrValue === 'pic.png',
        'count=' + attrResult.count + ' value=' + attrValue +
        (attrResult.error ? ' err=' + attrResult.error : ''));
    } else {
      const cssResult = evaluateExpression(env, flavor, initial);
      record(caseName, 'img 表达式命中该 img 元素',
        cssResult.count === 1 && cssResult.first === target,
        'count=' + cssResult.count + (cssResult.error ? ' err=' + cssResult.error : ''));
    }
    return;
  }

  record(caseName, '首次右键生成的表达式不含高亮 class',
    !containsHighlightClass(initial, flavor.highlightClass), '实际生成: ' + initial);

  // 元素此刻应该已经被高亮了，否则后面的断言没有意义
  const isHighlighted = target.classList.contains(flavor.highlightClass);
  record(caseName, '右键后目标元素确实被高亮（前提校验）', isHighlighted,
    'class=' + target.getAttribute('class'));

  // ---- 在"元素已被高亮"的状态下点模式按钮重新生成 ----
  deliver(env, { command: 'transform', [flavor.transformField]: initial, mode: 'original' });
  const originalMode = lastExpression(env, flavor);
  record(caseName, '已高亮状态下「原始」模式生成的表达式不含高亮 class',
    !containsHighlightClass(originalMode, flavor.highlightClass), '实际生成: ' + originalMode);

  deliver(env, { command: 'transform', [flavor.transformField]: originalMode, mode: 'smart' });
  const smartMode = lastExpression(env, flavor);
  record(caseName, '已高亮状态下「智能」模式生成的表达式不含高亮 class',
    !containsHighlightClass(smartMode, flavor.highlightClass), '实际生成: ' + smartMode);

  // SVG 元素的 className 在 DOM 里不是字符串，直接拼会漏出 [object Object]
  record(caseName, '表达式不含 [object Object]',
    originalMode.indexOf('[object Object]') === -1 &&
    smartMode.indexOf('[object Object]') === -1,
    'original=' + originalMode + ' smart=' + smartMode);

  // 生成结果必须仍能唯一定位回原元素
  const originalHit = evaluateExpression(env, flavor, originalMode);
  record(caseName, '「原始」模式表达式能唯一定位回原元素',
    originalHit.count === 1 && originalHit.first === target,
    'count=' + originalHit.count + ' expr=' + originalMode +
    (originalHit.error ? ' err=' + originalHit.error : ''));

  const smartHit = evaluateExpression(env, flavor, smartMode);
  record(caseName, '「智能」模式表达式能唯一定位回原元素',
    smartHit.count === 1 && smartHit.first === target,
    'count=' + smartHit.count + ' expr=' + smartMode +
    (smartHit.error ? ' err=' + smartHit.error : ''));

  // ---- 清掉高亮后，先前生成的表达式必须仍然有效（用户可见的最终后果）----
  deliver(env, { command: 'clearHighlights' });
  const stillHighlighted = countHighlighted(env, flavor);
  record(caseName, 'clearHighlights 后页面上不再残留高亮 class',
    stillHighlighted === 0, '残留 ' + stillHighlighted + ' 个');

  const afterClear = evaluateExpression(env, flavor, originalMode);
  record(caseName, '清高亮后「原始」表达式仍然命中（关键回归点）',
    afterClear.count === 1 && afterClear.first === target,
    'count=' + afterClear.count + ' expr=' + originalMode +
    (afterClear.error ? ' err=' + afterClear.error : ''));

  const afterClearSmart = evaluateExpression(env, flavor, smartMode);
  record(caseName, '清高亮后「智能」表达式仍然命中（关键回归点）',
    afterClearSmart.count === 1 && afterClearSmart.first === target,
    'count=' + afterClearSmart.count + ' expr=' + smartMode +
    (afterClearSmart.error ? ' err=' + afterClearSmart.error : ''));
}

/**
 * 单独验证 clearHighlights 可重复调用且幂等 —— 旧实现依赖 live NodeList 边遍历边删，
 * 一旦某个环境下返回的是静态集合就会死循环，所以必须连着调两次。
 * @param {object} flavor 变体描述
 * @returns {void}
 */
function runClearIdempotency(flavor) {
  const caseName = 'clearHighlights 幂等性';
  const env = createSandbox(flavor);
  const target = env.document.querySelectorAll('li.item')[1];

  simulateRightClick(env, target);
  deliver(env, { command: flavor.getCmd });
  record(caseName, '前置：右键后确实有高亮', countHighlighted(env, flavor) > 0, '');

  deliver(env, { command: 'clearHighlights' });
  deliver(env, { command: 'clearHighlights' });
  record(caseName, '连续两次 clearHighlights 后无残留',
    countHighlighted(env, flavor) === 0,
    '残留 ' + countHighlighted(env, flavor) + ' 个');
}

/**
 * 打印结果表并返回失败数。
 * @returns {number} 失败用例数
 */
function report() {
  const byCase = new Map();
  for (const r of results) {
    if (!byCase.has(r.caseName)) {
      byCase.set(r.caseName, []);
    }
    byCase.get(r.caseName).push(r);
  }

  console.log('');
  for (const [caseName, items] of byCase) {
    const failed = items.filter((i) => !i.ok);
    const mark = failed.length === 0 ? 'PASS' : 'FAIL';
    console.log('[' + mark + '] ' + caseName + '  (' + (items.length - failed.length) + '/' + items.length + ')');
    for (const item of items) {
      console.log('        ' + (item.ok ? '·' : '×') + ' ' + item.probeName +
        (item.ok ? '' : '  →  ' + item.detail));
    }
  }

  const total = results.length;
  const failed = results.filter((r) => !r.ok).length;
  console.log('');
  console.log('合计 ' + total + ' 项断言，通过 ' + (total - failed) + ' 项，失败 ' + failed + ' 项');
  return failed;
}

/**
 * 脚本入口。
 * @returns {void}
 */
function main() {
  const flavor = detectFlavor();
  console.log('被测变体: ' + flavor.kind +
    '  命名空间: ' + flavor.ns +
    '  高亮 class: ' + flavor.highlightClass);
  console.log('content.js: ' + CONTENT_JS);

  for (const item of buildCases()) {
    runCase(flavor, item);
  }
  runClearIdempotency(flavor);

  const failed = report();
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
