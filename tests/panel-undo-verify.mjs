/**
 * panel-undo-verify.mjs —— 路径框撤销 / 重做验证脚本
 *
 * 【要验证的缺陷】
 * 路径框是个普通 <textarea>，原生是支持 Ctrl+Z 的。但面板会在两个地方**程序化**写它的
 * value：右键 Get Selector、以及「智能 / 原始」模式按钮，两条路径最终都落到
 * panel.js 的 render() 里执行 `selectorEl.value = ...`。
 * 而浏览器实测行为是：**程序化赋值会把 textarea 的原生撤销栈整个清空**，
 * 之后按 Ctrl+Z 完全没有反应，document.execCommand('undo') 同样无效。
 * 于是用户表现为：手动敲了一段选择器 → 右键取了一次别的元素 → 想 Ctrl+Z 撤回来，按不动。
 *
 * 【为什么不能用原生撤销兜底】
 * 原生撤销栈被清空后无法从 JS 侧恢复（没有任何 API 能重建它），所以只能自管一份历史栈，
 * 把「用户编辑」和「程序化覆盖」都记进去，并用 preventDefault 顶掉浏览器那个已失效的原生撤销。
 *
 * 【验证方法】
 * 用 linkedom 解析真实的 i18n 面板 HTML（保证 id 不漂移），把 panel.js 原样塞进 node:vm
 * 沙箱执行，注入假的 chrome 端口，然后直接驱动 DOM 事件与 render()，断言：
 *   1. 撤销 / 重做能跨越「程序化覆盖」这一跳（原生撤销做不到的核心回归点）
 *   2. 撤销到底不越界
 *   3. 撤销后产生新编辑会截断重做分支
 *   4. 撤销会清掉挂起的防抖求值，不让旧输入把结果覆盖回去
 *   5. 撤销 / 重做都真的发了求值请求，结果框不会停在旧值
 *
 * 【用法】
 *   node tests/panel-undo-verify.mjs
 * 全部通过时进程退出码 0，任一用例失败退出码 1。
 *
 * 【依赖】
 * linkedom，装在工作区根目录的 node_modules 里；
 * 两个扩展项目本身仍然保持零依赖、无构建步骤。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseHTML } = require('linkedom');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PANEL_JS = path.join(ROOT, 'panel.js');

// panel.js 的防抖是 200ms，测试里等 280ms 留足余量
const SETTLE_MS = 280;

/** 全部断言结果 */
const results = [];

/**
 * 记一条断言结果。
 * @param {string} caseName 用例名
 * @param {string} probeName 断言描述
 * @param {boolean} ok 是否通过
 * @param {string} detail 失败时的补充信息
 * @returns {void}
 */
function record(caseName, probeName, ok, detail) {
  results.push({ caseName: caseName, probeName: probeName, ok: ok, detail: detail || '' });
}

////////////////////////////////////////////////////////////////////////////////
// 变体识别：同一份脚本同时服务 XPath 版与 CSS 版
////////////////////////////////////////////////////////////////////////////////

/**
 * 识别当前项目的 panel.js 属于哪个变体。
 * 两个项目结构同构，只有输入框 id、求值函数名、消息字段名不同。
 * @returns {{kind:string, field:string, evalCmd:string, panelHtml:string, inputId:string}} 变体描述
 */
function detectFlavor() {
  const src = fs.readFileSync(PANEL_JS, 'utf8');
  if (src.indexOf('onQueryInput') !== -1) {
    return {
      kind: 'xpath', field: 'query', evalCmd: 'evaluate',
      panelHtml: path.join(ROOT, 'i18n', 'zh_CN', 'xpath.html'), inputId: 'query'
    };
  }
  if (src.indexOf('onSelectorInput') !== -1) {
    return {
      kind: 'css', field: 'selector', evalCmd: 'evaluateSelector',
      panelHtml: path.join(ROOT, 'i18n', 'zh_CN', 'selector.html'), inputId: 'selector'
    };
  }
  throw new Error('无法识别的 panel.js 变体：既没有 onQueryInput 也没有 onSelectorInput');
}

////////////////////////////////////////////////////////////////////////////////
// 沙箱
////////////////////////////////////////////////////////////////////////////////

/**
 * 构建一个已装载 panel.js 的面板沙箱。
 *
 * 直接读真实的 i18n 面板 HTML，这样输入框 id 一旦改名，测试立刻失败而不是静默跳过。
 * @param {object} flavor 变体描述
 * @returns {{window:object, document:object, sandbox:object, sent:Array, input:object}} 沙箱句柄
 */
function createSandbox(flavor) {
  const { window, document } = parseHTML(fs.readFileSync(flavor.panelHtml, 'utf8'));

  // 记录面板发往 background 的消息，用来断言「撤销后确实重新求值了」
  const sent = [];
  const port = {
    postMessage: (message) => sent.push(message),
    onMessage: { addListener: () => {} },
    onDisconnect: { addListener: () => {} }
  };

  const sandbox = {
    window: window,
    document: document,
    // doresize() 里用了 self.innerHeight，沙箱得补上这个别名
    self: window,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    chrome: {
      devtools: { inspectedWindow: { tabId: 7 } },
      runtime: { connect: () => port, lastError: null },
      i18n: { getMessage: () => 'zh_CN' }
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Node: window.Node
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PANEL_JS, 'utf8'), sandbox, { filename: PANEL_JS });
  // 触发 window.onload → init()，绑定 input / keydown 监听并给历史栈打底
  window.onload();
  // 真实环境由 devtools.js 通过 setPort 把端口交给面板，测试里手动补上
  window.setPort(port);

  return { window: window, document: document, sandbox: sandbox, sent: sent, input: document.getElementById(flavor.inputId) };
}

////////////////////////////////////////////////////////////////////////////////
// 交互辅助
////////////////////////////////////////////////////////////////////////////////

/**
 * 等待防抖落定。
 * @param {number} ms 毫秒数
 * @returns {Promise<void>} 定时器到点后 resolve
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 模拟用户逐字输入后停顿到防抖落定。
 * @param {object} env 沙箱句柄
 * @param {string} text 要输入的文本
 * @returns {Promise<void>} 落定后 resolve
 */
async function typeInto(env, text) {
  env.input.value = text;
  env.input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await sleep(SETTLE_MS);
}

/**
 * 在路径框上按一个组合键。
 * linkedom 没有 KeyboardEvent 构造器，用普通 Event 手工挂修饰键属性即可满足 panel.js 的读取。
 * @param {object} env 沙箱句柄
 * @param {string} key 键名
 * @param {object} mods 修饰键
 * @returns {object} 派发出去的事件，可读 defaultPrevented
 */
function pressKey(env, key, mods) {
  const m = mods || {};
  const event = new env.window.Event('keydown', { bubbles: true, cancelable: true });
  event.key = key;
  event.ctrlKey = !!m.ctrl;
  event.metaKey = !!m.meta;
  event.shiftKey = !!m.shift;
  env.input.dispatchEvent(event);
  return event;
}

/**
 * 模拟页面回传：右键取到新选择器、或模式按钮算完新形态，都会走到 render() 覆盖路径框。
 * @param {object} env 沙箱句柄
 * @param {string} value 页面回传的新选择器
 * @returns {void}
 */
function renderOverwrite(env, value) {
  env.sandbox.render({ command: 'update', selector: value, query: value, results: ['结果文本', 1] });
}

/**
 * 取出已发出的求值请求里的选择器文本，按发送顺序排列。
 * @param {object} env 沙箱句柄
 * @param {object} flavor 变体描述
 * @returns {Array<string>} 选择器文本序列
 */
function sentSelectors(env, flavor) {
  return env.sent
    .filter((m) => m.command === flavor.evalCmd)
    .map((m) => m[flavor.field]);
}

////////////////////////////////////////////////////////////////////////////////
// 用例
////////////////////////////////////////////////////////////////////////////////

/**
 * 用例：撤销用户自己的输入。
 * @param {object} flavor 变体描述
 * @returns {Promise<void>} 用例跑完后 resolve
 */
async function runUndoOwnTyping(flavor) {
  const name = '撤销用户输入';
  const env = createSandbox(flavor);

  record(name, '初始历史栈为空状态打底', env.sandbox.historyStack.length === 1 && env.sandbox.historyStack[0] === '',
    JSON.stringify(env.sandbox.historyStack));

  await typeInto(env, 'div.foo');
  record(name, '输入后历史栈记下了新取值',
    env.sandbox.historyStack.indexOf('div.foo') !== -1,
    JSON.stringify(env.sandbox.historyStack));

  pressKey(env, 'z', { ctrl: true });
  record(name, 'Ctrl+Z 撤回到空', env.input.value === '', '当前值 ' + JSON.stringify(env.input.value));

  const event = pressKey(env, 'z', { ctrl: true });
  record(name, '已到栈底时不再越界', env.input.value === '' && env.sandbox.historyIndex === 0,
    'index=' + env.sandbox.historyIndex);
  record(name, 'Ctrl+Z 被 preventDefault 顶掉失效的原生撤销', event.defaultPrevented === true,
    'defaultPrevented=' + event.defaultPrevented);
}

/**
 * 用例：跨越「程序化覆盖」撤销 —— 本次缺陷的核心回归点。
 * 原生撤销栈在 render() 赋值那一步就被清空了，只有自管历史才能撤回来。
 * @param {object} flavor 变体描述
 * @returns {Promise<void>} 用例跑完后 resolve
 */
async function runUndoAcrossOverwrite(flavor) {
  const name = '撤销程序化覆盖（核心回归点）';
  const env = createSandbox(flavor);

  await typeInto(env, 'div.foo');
  renderOverwrite(env, 'html > body > div#main');
  record(name, '覆盖后路径框是新值', env.input.value === 'html > body > div#main', env.input.value);
  record(name, '覆盖也记进了历史栈',
    env.sandbox.historyStack.indexOf('html > body > div#main') !== -1,
    JSON.stringify(env.sandbox.historyStack));

  pressKey(env, 'z', { ctrl: true });
  record(name, 'Ctrl+Z 能撤回到覆盖前的输入（原生撤销做不到）',
    env.input.value === 'div.foo', '当前值 ' + JSON.stringify(env.input.value));

  pressKey(env, 'z', { ctrl: true });
  record(name, '再撤一次回到空', env.input.value === '', '当前值 ' + JSON.stringify(env.input.value));
}

/**
 * 用例：重做，以及撤销后新编辑截断重做分支。
 * @param {object} flavor 变体描述
 * @returns {Promise<void>} 用例跑完后 resolve
 */
async function runRedo(flavor) {
  const name = '重做与重做分支截断';
  const env = createSandbox(flavor);

  await typeInto(env, 'div.foo');
  renderOverwrite(env, '#main');
  pressKey(env, 'z', { ctrl: true });
  record(name, '撤销后处于中间态', env.input.value === 'div.foo', env.input.value);

  pressKey(env, 'z', { ctrl: true, shift: true });
  record(name, 'Ctrl+Shift+Z 重做回覆盖后的值', env.input.value === '#main', '当前值 ' + env.input.value);

  // 退到底再改，重做分支必须被截断，否则会跳到一个已经被丢弃的未来状态
  pressKey(env, 'z', { ctrl: true });
  pressKey(env, 'z', { ctrl: true });
  record(name, '退到栈底', env.sandbox.historyIndex === 0, 'index=' + env.sandbox.historyIndex);

  await typeInto(env, 'span.new');
  const stack = env.sandbox.historyStack.slice();
  record(name, '撤销后的新编辑截断了重做分支', stack.length === 2 && stack[1] === 'span.new',
    JSON.stringify(stack));

  pressKey(env, 'z', { ctrl: true, shift: true });
  record(name, '被截断后无法再重做', env.input.value === 'span.new', '当前值 ' + env.input.value);
}

/**
 * 用例：Ctrl+Y 是重做的另一套写法。
 * @param {object} flavor 变体描述
 * @returns {Promise<void>} 用例跑完后 resolve
 */
async function runRedoWithY(flavor) {
  const name = 'Ctrl+Y 重做';
  const env = createSandbox(flavor);

  await typeInto(env, 'a.b');
  pressKey(env, 'z', { ctrl: true });
  record(name, '先撤销', env.input.value === '', '当前值 ' + JSON.stringify(env.input.value));

  pressKey(env, 'y', { ctrl: true });
  record(name, 'Ctrl+Y 重做回原值', env.input.value === 'a.b', '当前值 ' + env.input.value);
}

/**
 * 用例：撤销必须立即重新求值，且要清掉挂起的防抖求值。
 * @param {object} flavor 变体描述
 * @returns {Promise<void>} 用例跑完后 resolve
 */
async function runUndoTriggersEvaluate(flavor) {
  const name = '撤销触发求值';
  const env = createSandbox(flavor);

  await typeInto(env, 'div.foo');
  env.sent.length = 0;

  pressKey(env, 'z', { ctrl: true });
  const immediate = sentSelectors(env, flavor);
  record(name, '撤销后立刻发出求值请求（不走 200ms 防抖）',
    immediate.length === 1 && immediate[0] === '', JSON.stringify(immediate));

  // 撤销后新敲一段，确认结果框跟着新值走
  env.sent.length = 0;
  await typeInto(env, 'p.q');
  const after = sentSelectors(env, flavor);
  record(name, '撤销后的新编辑照常求值',
    after.length === 1 && after[0] === 'p.q', JSON.stringify(after));
}

/**
 * 用例：撤销时挂起的编辑求值不能反过来把结果覆盖回去。
 * @param {object} flavor 变体描述
 * @returns {Promise<void>} 用例跑完后 resolve
 */
async function runUndoClearsPendingEvaluate(flavor) {
  const name = '撤销清掉挂起求值';
  const env = createSandbox(flavor);

  // 敲完不等待防抖，直接撤销：此时 evaluateTimer 里还挂着 'div.pending'
  env.input.value = 'div.pending';
  env.input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  pressKey(env, 'z', { ctrl: true });
  record(name, '撤销回到空', env.input.value === '', '当前值 ' + JSON.stringify(env.input.value));

  await sleep(SETTLE_MS);
  const sent = sentSelectors(env, flavor);
  record(name, '挂起的那次求值没有再发出去（否则会覆盖撤销结果）',
    sent.indexOf('div.pending') === -1, JSON.stringify(sent));
}

////////////////////////////////////////////////////////////////////////////////
// 报告与入口
////////////////////////////////////////////////////////////////////////////////

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
 * @returns {Promise<void>} 全部用例跑完后 resolve
 */
async function main() {
  const flavor = detectFlavor();
  console.log('被测变体: ' + flavor.kind + '  输入框 id: #' + flavor.inputId + '  字段: ' + flavor.field);
  console.log('panel.js: ' + PANEL_JS);
  console.log('面板 HTML: ' + flavor.panelHtml);

  await runUndoOwnTyping(flavor);
  await runUndoAcrossOverwrite(flavor);
  await runRedo(flavor);
  await runRedoWithY(flavor);
  await runUndoTriggersEvaluate(flavor);
  await runUndoClearsPendingEvaluate(flavor);

  const failed = report();
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
