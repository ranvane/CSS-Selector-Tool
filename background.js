// CSS Selector Finder background service worker（Manifest V3）
//
// 职责：
// 1. 创建"Get Selector"右键菜单；
// 2. 将右键菜单点击事件路由到 content script；
// 3. 将 devtools 面板与 content script 的消息相互转发（通过端口表 ports）；
// 4. 把 enable.js 注入页面以重新启用右键菜单（world: MAIN，与原版行为一致）。
//
// MV3 注意：service worker 空闲时会被浏览器终止，ports 表是内存态数据，
// 会随终止而丢失。devtools.js 已实现断线自动重连并重新发送 init 消息，
// 因此这里只需在收到 init 时（重新）登记端口即可，无需额外持久化。

var ports = {};

// 右键菜单的固定标识
var MENU_ID = 'get_css_selector_menu';

// 当插件安装或更新时创建上下文菜单
chrome.runtime.onInstalled.addListener(function () {
  // 先清空旧菜单，避免重复创建相同 id 报错（扩展更新时 onInstalled 仍会触发）
  chrome.contextMenus.removeAll(function () {
    if (chrome.runtime.lastError) {
      console.error('清空菜单失败:', chrome.runtime.lastError.message);
    }
    chrome.contextMenus.create({
      id: MENU_ID,
      title: chrome.i18n.getMessage('menuItem'),
      contexts: ['all']
    });
  });
});

// 监听上下文菜单点击事件
chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === MENU_ID) {
    getSelector(info, tab);
  }
});

// 向标签页 content script 发送消息；若接收端不存在（如扩展重载后旧页面未重注入
// content script），自动注入 content.js 并重试一次。
function sendMessageWithInjection(tabId, msg, onDone) {
  chrome.tabs.sendMessage(tabId, msg, function (response) {
    if (!chrome.runtime.lastError) {
      if (onDone) onDone(null, response);
      return;
    }
    if (chrome.runtime.lastError.message.indexOf('Receiving end does not exist') === -1) {
      if (onDone) onDone(chrome.runtime.lastError.message);
      return;
    }
    console.log('[360CSS] content script 未注入，自动注入后重试');
    var target = { tabId: tabId, allFrames: true };
    chrome.scripting.insertCSS({ target: target, files: ['content/style.css'] }).catch(function (e) {
      console.error('[360CSS] 注入样式失败:', e.message);
    });
    chrome.scripting.executeScript({ target: target, files: ['content/content.js'] }).then(function () {
      chrome.tabs.sendMessage(tabId, msg, function (retryResponse) {
        if (chrome.runtime.lastError) {
          console.error('[360CSS] 注入后仍无法送达消息:', chrome.runtime.lastError.message);
          if (onDone) onDone(chrome.runtime.lastError.message);
        } else if (onDone) {
          onDone(null, retryResponse);
        }
      });
    }).catch(function (err) {
      console.error('[360CSS] 自动注入 content script 失败:', err.message);
      if (onDone) onDone(err.message);
    });
  });
}

// 右键菜单点击后，通知 content script 计算并上报被点击元素的选择器
function getSelector(info, tab) {
  if (tab.id in ports) {
    try {
      ports[tab.id].postMessage({command: 'activatePanel'});
    } catch (e) {
      console.error('[360CSS] 发送激活面板消息失败:', e);
    }
    var msg = {
      command: 'getSelector',
      tabId: tab.id
    };
    sendMessageWithInjection(tab.id, msg, function (err) {
      if (err) console.log('发送 getSelector 消息失败:', err);
    });
  } else {
    // 开发者工具未打开或端口尚未登记时，提示用户先打开开发者工具
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/48.png',
      title: 'CSS Selector查询工具',
      message: chrome.i18n.getMessage('noPanel')
    });
  }
}

// 接收 content script 的消息（查询结果），转发给对应标签页的 devtools 端口
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  var tabId = sender.tab ? sender.tab.id : null;
  if (tabId && tabId in ports) {
    ports[tabId].postMessage(request);
    // 发送响应以关闭消息端口，避免 "The message port closed before a response was received" 错误
    sendResponse({ success: true });
  } else if (chrome.runtime.lastError) {
    // 忽略无效端口消息
    sendResponse({ success: false, error: chrome.runtime.lastError.message });
  } else {
    // 即使没有找到端口，也发送响应以避免端口关闭错误
    sendResponse({ success: false, error: 'Port not found for tab ' + tabId });
  }
});

// 接收 devtools 面板的端口连接，绑定消息处理
chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'cssSelectorFinder') {
    return;
  }

  var extensionListener = function (msg) {
    if (msg.command === 'init') {
      // 登记端口：将 devtools 面板与被检查页面绑定
      ports[msg.tabId] = port;
    } else if (msg.command === 'evaluateSelector' || msg.command === 'transform') {
      // 面板与页面之间的两条指令都需 content script 执行：
      // evaluateSelector —— 对路径框当前选择器求值；transform —— 按模式现算并覆盖路径框
      sendMessageWithInjection(msg.tabId, msg, function (err) {
        if (err) console.log('发送 ' + msg.command + ' 消息失败:', err);
      });
    } else if (msg.command === 'enablecon') {
      // 在页面主世界中注入 enable.js，重新启用右键菜单
      chrome.scripting.executeScript({
        target: { tabId: msg.tabId, allFrames: true },
        files: ['enable.js'],
        world: 'MAIN'
      });
    } else {
      port.postMessage(msg);
    }
  };

  // 端口断开（devtools 关闭或 service worker 被终止）时清理登记
  port.onDisconnect.addListener(function (disconnectedPort) {
    port.onMessage.removeListener(extensionListener);

    var disconnectedTabId = null;
    for (var id in ports) {
      if (ports[id] === disconnectedPort) {
        disconnectedTabId = id;
        delete ports[id];
        break;
      }
    }

    // 当 devtools 面板关闭时，清除页面上的高亮显示
    if (disconnectedTabId) {
      chrome.tabs.sendMessage(parseInt(disconnectedTabId, 10), {
        command: 'clearHighlights'
      }, function (response) {
        if (chrome.runtime.lastError) {
          console.log('清除高亮时出错: ' + chrome.runtime.lastError.message);
        } else {
          console.log('已清除页面高亮显示');
        }
      });
    }
  });

  port.onMessage.addListener(extensionListener);
});
