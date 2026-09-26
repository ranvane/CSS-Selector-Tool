console.log("[360CSS] panel.js 调用");
// Global variables.
var enableEl, selectorEl, resultsEl, nodeCountEl, nodeCountText;
var port; // 存储端口连接
var targetSmartMode = true;  // 模式按钮的目标：点击后路径框会被改写成智能缩写(true)或完整路径(false)
var evaluateTimer = null;    // 路径框编辑后的求值防抖定时器
var EVALUATE_DEBOUNCE_MS = 200;

/**
 * 请求页面对指定选择器求值，结果由页面回传后写入结果框，本函数不直接碰结果框。
 * @param {string} selector 待求值的 CSS 选择器
 */
var evaluateSelector = function(selector) {
  console.log("[360CSS] panel.js evaluateSelector 调用:", selector);
  if (!port) {
    console.warn("[360CSS] panel.js 端口未连接");
    return;
  }

  var request = {
    'command': 'evaluateSelector',
    'selector': selector,
    'tabId': chrome.devtools.inspectedWindow.tabId
  };
  console.log("[360CSS] panel.js 发送 evaluateSelector 请求:", request);
  try {
    port.postMessage(request);
    console.log("[360CSS] panel.js evaluateSelector 请求发送成功");
  } catch (e) {
    console.error("[360CSS] panel.js 发送 evaluateSelector 请求失败:", e);
  }
};

/**
 * 路径框编辑防抖：连续敲击只在停顿后求值一次。
 * 不防抖的话每个字符都会触发一次 clearHighlights + querySelectorAll，页面高亮会疯狂闪烁。
 */
function onSelectorInput() {
  if (evaluateTimer) {
    clearTimeout(evaluateTimer);
  }
  evaluateTimer = setTimeout(function() {
    evaluateTimer = null;
    var value = selectorEl ? selectorEl.value : '';
    // 在防抖落定时才记历史：一串连续敲击算一条撤销单位，
    // 与浏览器把整段输入合并成一个撤销单元的行为一致，
    // 免得敲 30 个字符就得按 30 次 Ctrl+Z
    recordHistory(value);
    evaluateSelector(value);
  }, EVALUATE_DEBOUNCE_MS);
}

// ---- 路径框撤销 / 重做 ----
// 不能依赖 textarea 的原生撤销栈：面板在右键获取、模式按钮切换时都会程序化写
// selectorEl.value，而程序化赋值会把原生撤销栈整个清空（实测：赋值后按 Ctrl+Z
// 完全无反应，document.execCommand('undo') 同样无效）。所以这里自管一份历史栈，
// 把「用户编辑」和「程序化覆盖」都记进去，撤销能力就不再依赖浏览器内部状态。
var historyStack = [];  // 选择器取值历史，下标 0 是最初状态
var historyIndex = -1;  // 当前所处的历史位置
var HISTORY_MAX = 200;  // 条数上限，防止长时间编辑把内存吃满

/**
 * 把一次取值变化记入历史栈。
 * 连续相同取值不记（否则光标移动之类的空变化会产生无意义条目）；
 * 若当前不在栈顶，先截断重做分支 —— 撤销之后再做新编辑，
 * 原本可以重做回去的那些历史已经失去意义。
 * @param {string} value 变化后的选择器文本
 */
function recordHistory(value) {
  // 已在栈顶且取值相同：什么都不用做
  if (historyIndex >= 0 && historyStack[historyIndex] === value) {
    return;
  }
  historyStack.length = historyIndex + 1;
  historyStack.push(value);
  // 超出上限时丢最老的一条，栈顶始终是当前取值
  if (historyStack.length > HISTORY_MAX) {
    historyStack.shift();
  }
  historyIndex = historyStack.length - 1;
}

/**
 * 在历史栈上前进或后退一步，把结果写回路径框并立即求值。
 * 越界时不做任何事（到头就不动，与原生行为一致）。
 * @param {number} delta -1 表示撤销，+1 表示重做
 */
function applyHistory(delta) {
  // 防抖窗口里可能还挂着一笔没落定的输入，先把它补记进历史再移动指针。
  // 不补记的话「刚敲完就按 Ctrl+Z」会因为这笔还没进栈而越界落空，
  // 用户看到的就是撤销又坏了 —— 和原生撤销失效时的观感完全一样。
  if (evaluateTimer) {
    recordHistory(selectorEl ? selectorEl.value : '');
    clearTimeout(evaluateTimer);
    evaluateTimer = null;
  }
  var next = historyIndex + delta;
  if (next < 0 || next >= historyStack.length) {
    return;
  }
  historyIndex = next;
  var value = historyStack[historyIndex];
  if (selectorEl && selectorEl.value !== value) {
    selectorEl.value = value;
    // 这里不走 200ms 防抖：撤销是用户明确的一次动作，结果框必须立刻跟上
    evaluateSelector(value);
  }
}

/**
 * 路径框的撤销 / 重做快捷键。只挂在路径框上，因此不影响 DevTools 的其他区域。
 * Ctrl+Z 撤销；Ctrl+Shift+Z 与 Ctrl+Y 重做（两种写法都支持，跨平台习惯不同）。
 * @param {KeyboardEvent} event 键盘事件
 */
function onSelectorKeydown(event) {
  if (!event.ctrlKey && !event.metaKey) {
    return;
  }
  var key = String(event.key).toLowerCase();
  if (key === 'z') {
    // 必须 preventDefault：否则浏览器会先执行它自己的（已被清空的）原生撤销
    event.preventDefault();
    applyHistory(event.shiftKey ? 1 : -1);
  } else if (key === 'y') {
    event.preventDefault();
    applyHistory(1);
  }
}

/**
 * 模式按钮专用：请求页面按目标模式对路径框当前选择器现算，结果由页面覆盖回路径框。
 * @param {string} mode 'smart' 生成智能缩写，'original' 生成完整路径
 */
function requestTransform(mode) {
  if (!port) {
    console.warn("[360CSS] panel.js 端口未连接");
    return;
  }
  var request = {
    'command': 'transform',
    'selector': selectorEl ? selectorEl.value : '',
    'mode': mode,
    'tabId': chrome.devtools.inspectedWindow.tabId
  };
  console.log("[360CSS] panel.js 发送 transform 请求:", request);
  try {
    port.postMessage(request);
  } catch (e) {
    console.error("[360CSS] panel.js 发送 transform 请求失败:", e);
  }
}

var enableconQuery = function(event) {
  console.log("[360CSS] panel.js enableconQuery 调用");
  if (event) {
    // 阻止 <a href="#"> 的默认跳转行为
    event.preventDefault();
  }
  if (!port) {
    console.warn("[360CSS] panel.js 端口未连接");
    return;
  }

  var request = {
    'command': 'enablecon',
    'tabId': chrome.devtools.inspectedWindow.tabId
  };
  console.log("[360CSS] panel.js 发送 enablecon 请求:", request);
  try {
    port.postMessage(request);
    console.log("[360CSS] panel.js enablecon 请求发送成功");
  } catch (e) {
    console.error("[360CSS] panel.js 发送 enablecon 请求失败:", e);
  }
};

function init(){
    console.log("[360CSS] panel.js 初始化开始");

    // 获取端口连接 - 这里会在面板显示时由 devtools.js 设置
    // 注意：在 init 调用时，端口可能还没有设置

    selectorEl = document.getElementById('selector');
    resultsEl = document.getElementById('results');
    nodeCountEl = document.getElementById('node-count');
    enableEl = document.getElementById('enablecon');

    nodeCountText = document.createTextNode('0');
    if (nodeCountEl) {
        nodeCountEl.appendChild(nodeCountText);
    }

    if (selectorEl && enableEl) {
        selectorEl.addEventListener('input', onSelectorInput);
        selectorEl.addEventListener('keydown', onSelectorKeydown);
        // 历史栈以输入框的初始内容打底，保证面板一打开就能 Ctrl+Z 回到空状态
        historyStack = [selectorEl.value];
        historyIndex = 0;
        enableEl.addEventListener('click', enableconQuery);
        var toggleBtn = document.getElementById('toggle-btn');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', window.toggleMode);
        }
        console.log("[360CSS] panel.js 事件监听器已绑定");
    } else {
        console.error("[360CSS] panel.js 无法找到必要的元素");
    }

    console.log("[360CSS] panel.js 初始化完成");
}

/**
 * 模式按钮：只处理路径框当前的选择器 —— 请求页面按目标模式现算后覆盖回路径框。
 * 按钮文字表示"点击后将变成什么"，因此先用旧目标算出本次模式，再翻转目标。
 */
window.toggleMode = function() {
  var mode = targetSmartMode ? 'smart' : 'original';
  targetSmartMode = !targetSmartMode;

  var btn = document.getElementById('toggle-btn');
  if (btn) {
    btn.textContent = targetSmartMode ? '智能' : '原始';
    btn.title = targetSmartMode ? '把路径框中的选择器缩写为智能 CSS Selector'
                                 : '把路径框中的选择器还原为完整路径';
  }
  requestTransform(mode);
};
function render( request ){
    console.log("[360CSS] panel.js 渲染数据:", request);
    if( request.command == 'update' ) {
        // selector 非 null 表示页面要求覆盖路径框：右键 Get Selector 拿到了新选择器，
        // 或模式按钮现算出了新形态。结果已随本消息带回，只写入、不重复求值。
        if (request['selector'] != null && selectorEl) {
          // 丢弃挂起的编辑求值，否则旧输入会在新选择器之后被求值并覆盖回去
          if (evaluateTimer) {
            clearTimeout(evaluateTimer);
            evaluateTimer = null;
          }
          selectorEl.value = request['selector'];
          // 程序化覆盖也必须记进历史，否则用户右键一次就再也撤不回自己敲的选择器
          recordHistory(request['selector']);
        }
        if (request['results'] !== null && resultsEl) {
          resultsEl.value = request['results'][0];
          if (nodeCountText) {
            nodeCountText.nodeValue = request['results'][1];
          }
        }
    }
}

function windowHeight() {
    var de = document.documentElement;
    return self.innerHeight||(de && de.clientHeight)||document.body.clientHeight;
}

function doresize(){
    var wh=windowHeight();
    var contentEl = document.getElementById("content");
    var selectorEl = document.getElementById("selector");
    if (contentEl && selectorEl) {
        contentEl.style.height = (wh - selectorEl.offsetTop - 10)+"px";
    }
}

window.onresize=function(){
    doresize();
}

window.onload = function(){
    console.log("[360CSS] panel.js 窗口加载完成");
    doresize();
    init();
};

// 添加一个全局函数，让 devtools.js 可以设置端口
window.setPort = function(newPort) {
    console.log("[360CSS] panel.js 设置端口");
    port = newPort;
};
