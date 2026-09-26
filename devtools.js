// CSS Selector Finder 开发者工具面板入口
// 职责：创建 DevTools 面板、管理与 background service worker 的端口连接
//
// 重要说明（MV3 适配）：
// 在 Manifest V3 中 background 是 service worker，空闲约 30 秒后会被浏览器终止。
// service worker 被终止时，与 devtools 页面建立的端口连接会断开，且其内存中的
// ports 表也会丢失。因此这里必须实现【断线自动重连】：断开后重新 connect，
// 并重新发送 init 消息让 background 重新登记端口，否则面板和右键菜单会全部失灵。

var port = null;        // 当前端口连接
var _window = null;     // 面板窗口引用（面板显示后才有值）
var data = null;        // 面板未显示时暂存的消息
var retryTimer = null;  // 重连定时器句柄
var _panel = null;      // 面板对象引用，用于 activate() 切换到面板
var retryCount = 0;     // 当前重试次数
var maxRetries = 5;     // 最大重试次数

// 计算面板 HTML 的国际化路径
// chrome.i18n.getMessage("@@ui_locale") 在不同 Chrome 版本/平台可能返回
// "zh_CN"（下划线）或 "zh-CN"（连字符）等格式，这里统一转成下划线再拼接，并兜底 zh_CN。
function getPanelPageUrl() {
  var locale = chrome.i18n.getMessage('@@ui_locale') || 'zh_CN';
  locale = String(locale).replace('-', '_');
  if (locale === 'en_US') {
    // i18n 目录提供 en / en_US / zh_CN 三个版本，en_US 与 en 内容一致，统一走 en
    locale = 'en';
  }
  return 'i18n/' + locale + '/selector.html';
}

// 向 background 发送 init 消息，登记当前被检查页面的端口
function sendInitMessage() {
  if (!port) return;
  var initMsg = {
    command: 'init',
    tabId: chrome.devtools.inspectedWindow.tabId
  };
  try {
    port.postMessage(initMsg);
  } catch (e) {
    console.error('[360CSS] 发送初始化消息失败:', e);
  }
}

// 打开一条新端口连接并绑定消息监听
function setupPortConnection() {
  try {
    port = chrome.runtime.connect({ name: 'cssSelectorFinder' });
  } catch (e) {
    console.error('[360CSS] 创建端口连接失败:', e);
    port = null;
    scheduleReconnect();
    return;
  }

  // 连接成功，重置重试计数器
  retryCount = 0;

  // 接收 background 转发过来的消息（来自 content script 的查询结果）
  port.onMessage.addListener(function (msg) {
    // 处理 activatePanel 命令：自动切换到 CSS Selector 面板
    if (msg.command === 'activatePanel') {
      if (_panel && typeof _panel.activate === 'function') {
        _panel.activate();
      }
      return;
    }

    // 正常的选择器查询结果消息：渲染到面板
    if (_window) {
      if (_window.render && typeof _window.render === 'function') {
        _window.render(msg);
      } else {
        console.warn('[360CSS] 面板 render 方法不存在');
      }
    } else {
      // 面板尚未显示，缓存消息等待 onShown 时回放
      data = msg;
    }
  });

  // 端口断开（通常是 background service worker 被终止）时自动重连
  port.onDisconnect.addListener(function () {
    if (chrome.runtime.lastError) {
      // 忽略断开时的 lastError
    }
    console.log('[360CSS] 端口断开，准备自动重连');
    port = null;
    scheduleReconnect();
  });

  // 连接建立后立即登记端口（不必等面板显示，右键菜单即可用）
  sendInitMessage();

  // 若面板已显示，把新端口交给面板使用
  if (_window) {
    _window.port = port;
  }
}

// 延迟重连（1 秒后），避免在 devtools 关闭卸载的瞬间反复尝试
function scheduleReconnect() {
  if (retryTimer) {
    clearTimeout(retryTimer);
  }

  // 检查是否超过最大重试次数
  if (retryCount >= maxRetries) {
    console.log('[360CSS] 已达最大重试次数 (' + maxRetries + ')，停止重连');
    return;
  }

  retryTimer = setTimeout(function () {
    retryTimer = null;
    retryCount++;
    console.log('[360CSS] 尝试重连 (' + retryCount + '/' + maxRetries + ')');
    setupPortConnection();
  }, 1000);
}

chrome.devtools.panels.create(
  'CSS Selector Finder',
  'icons/16.png',
  getPanelPageUrl(),
  function (panel) {
    _panel = panel;
    console.log('[360CSS] devtools.js 面板创建成功');

    // 面板显示时，更新窗口引用并确保端口就绪
    panel.onShown.addListener(function (win) {
      _window = win;
      if (port) {
        _window.port = port;
      }
      // 面板显示时重新登记端口（重连后可能已经变化）
      sendInitMessage();
      // 若面板显示前缓存过消息，立即回放
      if (data) {
        if (_window.render && typeof _window.render === 'function') {
          _window.render(data);
        }
        data = null;
      }
    });

    panel.onHidden.addListener(function () {
      // 面板隐藏不做特殊处理，只需保留窗口引用用于下次显示
    });

    // 建立初始端口连接
    setupPortConnection();
  }
);

console.log('[360CSS] devtools.js 加载完成');
