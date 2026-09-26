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
    evaluateSelector(selectorEl ? selectorEl.value : '');
  }, EVALUATE_DEBOUNCE_MS);
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
