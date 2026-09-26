var clickedEl = null;

// 防止重复注入叠加监听器：background 在 content script 缺失时会自动重注入本文件，
// 若页面 isolated world 仍在（极少数场景），重复注册会导致 mousedown/onMessage 叠加。
if (!window.__cssSelectorFinderMouseBound) {
  window.__cssSelectorFinderMouseBound = true;
  document.addEventListener("mousedown", function(event){
           clickedEl = event.target;
  }, true);
}

// Extension namespace.
var sh = sh || {};

// 当前生效的 CSS 选择器（求值、生成缩写均以它为准）
sh.selector_ = '';

// 页面高亮用的 class 名，与 content/style.css 里的选择器保持一致
var HIGHLIGHT_CLASS = 'chromecssSelectorFinder';


////////////////////////////////////////////////////////////////////////////////
// 通用辅助函数与常量

/**
 * 取元素在父元素全部子元素中的序号（从 1 开始）。
 * 这就是 CSS :nth-child 的语义 —— 统计所有元素兄弟，不区分标签名，
 * 与 XPath 里"同名同类兄弟计数"的做法不同，因此单独实现。
 * @param {Element} el 目标元素
 * @returns {number} 序号，1 表示它是父元素下的第一个子元素
 */
sh.getChildIndex = function(el) {
  var index = 1;
  for (var sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
    index++;
  }
  return index;
};

/**
 * 读取元素上的 class 列表，SVG 元素没有 class 属性时返回空数组。
 *
 * 两个必须注意的点：
 * 1. 走 getAttribute('class') 而不是 classList —— DOMTokenList 的索引属性并非所有环境都可靠，
 *    而 class 属性是规范保证的，且与 classList 始终同步。
 * 2. 必须剔除本扩展自己加的高亮 class。生成选择器时目标元素往往还处于高亮状态，
 *    不过滤的话会把 .chromecssSelectorFinder 写进选择器，导致高亮一撤选择器就失效。
 * @param {Element} el 目标元素
 * @returns {Array<string>} class 名数组（已剔除高亮 class）
 */
sh.getClassList = function(el) {
  var raw = el.getAttribute ? el.getAttribute('class') : '';
  if (!raw) {
    return [];
  }
  var all = raw.trim().split(/\s+/);
  var result = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i] && all[i] !== HIGHLIGHT_CLASS) {
      result.push(all[i]);
    }
  }
  return result;
};

/**
 * 用 CSS.escape 转义 id / class，保证含冒号、点、空格等特殊字符时选择器依然合法。
 */
function escapeIdent(name) {
  return CSS.escape(name);
}

/**
 * 生成元素的完整选择器：从 <html> 一路用 " > " 拼下来的完整路径。
 * 与 XPath 版的 makeQueryForElement 对应，id 优先作为锚点，必要时用 :nth-child 锁定位置。
 * @param {Element} el 目标元素
 * @returns {string} 完整选择器，例如 "html > body > div#main > p:nth-child(2)"
 */
sh.makeSelectorForElement = function(el) {
  var parts = [];
  for (var node = el; node && node.nodeType === Node.ELEMENT_NODE; node = node.parentNode) {
    var part = node.tagName.toLowerCase();
    // 有 id 用 id（最短且最稳的锚点），否则把 class 全带上
    if (node.id) {
      part += '#' + escapeIdent(node.id);
    } else {
      var classes = sh.getClassList(node);
      for (var i = 0; i < classes.length; i++) {
        part += '.' + escapeIdent(classes[i]);
      }
    }
    // 只要父元素下还有其他子元素，就必须用 :nth-child 锁定位置 —— 即使自己是第一个。
    // 仅当自己是唯一子元素时才能省略，否则形如 "ul > li" 会同时命中所有 li。
    if (node.previousElementSibling || node.nextElementSibling) {
      part += ':nth-child(' + sh.getChildIndex(node) + ')';
    }
    parts.unshift(part);
  }
  return parts.join(' > ');
};

/**
 * 生成智能缩写选择器：按"最短且能唯一定位"的原则逐级降级。
 * 与 XPath 版的 makeSmartQueryForElement 策略一一对应：
 *   id → 标签名 → 标签名+class → 最近 id 祖先 → 最近 class 祖先 → 完整路径。
 * @param {Element} el 目标元素
 * @returns {string} 尽可能短的唯一选择器
 */
sh.makeSmartSelectorForElement = function(el) {
  // 1. 有 id → 最短
  if (el.id) {
    return '#' + escapeIdent(el.id);
  }

  var tag = el.tagName.toLowerCase();

  // 2. 单独标签名就能唯一定位
  if (document.querySelectorAll(tag).length === 1) {
    return tag;
  }

  // 3. 标签名 + 完整 class 串能唯一定位
  var classes = sh.getClassList(el);
  if (classes.length) {
    var withClasses = tag;
    for (var i = 0; i < classes.length; i++) {
      withClasses += '.' + escapeIdent(classes[i]);
    }
    if (document.querySelectorAll(withClasses).length === 1) {
      return withClasses;
    }
  }

  // 4. 向上找最近的 id 祖先，用 "#祖先锚点 标签" 截断路径。
  //    必须校验唯一性：id 只保证祖先唯一，"#祖先 标签" 仍可能命中多个同名后代，
  //    此时不返回，继续向上找更近的锚点。
  var current = el.parentNode;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    if (current.id) {
      var byId = '#' + escapeIdent(current.id) + ' ' + tag;
      if (document.querySelectorAll(byId).length === 1) {
        return byId;
      }
    }
    current = current.parentNode;
  }

  // 5. 向上找最近的 class 祖先
  current = el.parentNode;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    var ancClasses = sh.getClassList(current);
    for (var j = 0; j < ancClasses.length; j++) {
      var candidate = '.' + escapeIdent(ancClasses[j]) + ' ' + tag;
      if (document.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
    }
    current = current.parentNode;
  }

  // 6. 回退：完整路径（无更短方案）
  return sh.makeSelectorForElement(el);
};

/**
 * 给命中节点加上高亮 class。
 * @param {NodeList|Array} nodes 命中的节点集合
 */
sh.highlightNodes = function(nodes) {
  for (var i = 0, l = nodes.length; i < l; i++) {
    nodes[i].classList.add(HIGHLIGHT_CLASS);
  }
};

/**
 * 清掉页面上所有高亮。
 * 先把 live NodeList 拷成静态数组再逐个移除：直接边遍历边删依赖 NodeList 是实时的，
 * 一旦某个环境下返回的是静态集合，while 循环就永远退不出去。
 */
sh.clearHighlights = function() {
  var list = Array.prototype.slice.call(document.getElementsByClassName(HIGHLIGHT_CLASS));
  for (var i = 0; i < list.length; i++) {
    list[i].classList.remove(HIGHLIGHT_CLASS);
  }
};

/**
 * 对选择器求值，返回 [结果文本, 节点数]，并给命中的节点加高亮。
 * 与 XPath 版的 evaluateQuery 不同，CSS 选择器只能选中元素，
 * 没有 XPath 那种布尔/数字/字符串标量求值，结果固定是节点文本的拼接。
 * @param {string} selector CSS 选择器
 * @returns {Array} [结果文本, 命中节点数]
 */
sh.evaluateSelector = function(selector) {
  var nodes = null;
  try {
    nodes = document.querySelectorAll(selector);
  } catch (e) {
    // 空字符串、语法错误、非法伪元素（::before）都会抛异常
    return ['[INVALID SELECTOR]', 0];
  }

  var str = '';
  var nodeCount = nodes.length;
  if (nodeCount === 0) {
    return ['[NULL]', 0];
  }
  for (var i = 0; i < nodeCount; i++) {
    if (i) {
      str += '\n';
    }
    str += nodes[i].textContent;
  }

  sh.highlightNodes(nodes);
  return [str, nodeCount];
};

/**
 * 把选择器解析成唯一的元素节点。
 * @param {string} selector CSS 选择器
 * @returns {Element|null} 命中的第一个元素；选择器非法或没命中时返回 null
 */
sh.resolveElement_ = function(selector) {
  try {
    return document.querySelector(selector);
  } catch (e) {
    return null;
  }
};

/**
 * 模式按钮的现算入口：把路径框当前的选择器解析成元素节点，
 * 再按目标模式重新生成选择器（智能缩写 / 完整路径）覆盖回路径框。
 * 解析不出元素时保持路径框原样，只刷新结果框（显示非法选择器或 [NULL] 提示）。
 * @param {string} selector 路径框当前的选择器
 * @param {string} mode 'smart' 生成智能缩写，'original' 生成完整路径
 */
sh.transformSelector_ = function(selector, mode) {
  var el = sh.resolveElement_(selector);
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    console.log('[360CSS] 选择器未定位到元素，保持路径框原样:', selector);
    sh.selector_ = selector;
    sh.report_(null);
    return;
  }
  sh.report_(mode === 'smart' ? sh.makeSmartSelectorForElement(el)
                              : sh.makeSelectorForElement(el));
};

/**
 * 唯一的回传出口：按当前选择器求值，再把结果（必要时连同新选择器）发回面板。
 * @param {string|null} displaySelector 非 null 时表示覆盖面板路径框的内容；
 *        为 null 时只回传结果，不动路径框
 */
sh.report_ = function(displaySelector) {
  // displaySelector 非 null 同时意味着"切换当前生效的选择器"
  if (displaySelector !== null) {
    sh.selector_ = displaySelector;
  }
  // 每次回传都对应一次全新求值，先清掉上一次的高亮，避免同一节点被反复叠加高亮 class
  sh.clearHighlights();
  var results = sh.selector_ ? sh.evaluateSelector(sh.selector_) : ['', 0];
  var request = {
    'command': 'update',
    'selector': displaySelector,
    'results': results
  };
  console.log("[360CSS] content.js 发送消息到 background:", request);
  chrome.runtime.sendMessage(request, function(response) {
    if (chrome.runtime.lastError) {
      console.error("[360CSS] 发送消息到 background 出错:", chrome.runtime.lastError.message);
    }
  });
};

if (!window.__cssSelectorFinderMessageBound) {
  window.__cssSelectorFinderMessageBound = true;
  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
      console.log("[360CSS] content.js 收到消息:", request);
      switch ( request.command ) {
          case 'evaluateSelector':
              // 用户编辑了路径框：只更新当前选择器并回传结果，不覆盖路径框
              sh.selector_ = request['selector'];
              sh.report_(null);
              break;
          case 'transform':
              // 模式按钮：对路径框当前选择器现算，结果覆盖回路径框
              sh.transformSelector_(request['selector'], request['mode']);
              break;
          case 'getSelector':
              // 右键 Get Selector：算出命中元素的完整选择器并覆盖路径框；
              // 未捕获到元素时传 null，保留用户原有的选择器不被清空
              console.log("[360CSS] getSelector 命令，目标元素:", clickedEl);
              sh.report_(clickedEl ? sh.makeSelectorForElement(clickedEl) : null);
              break;
          case 'clearHighlights':
              // 清除高亮显示
              sh.clearHighlights();
              console.log("[360CSS] 已清除页面高亮显示");
              break;
      }
      // 同步应答并返回 false，避免 return true 却无应答导致发送方报 "message port closed"
      sendResponse({ status: 'ok' });
      return false;
  });
}
