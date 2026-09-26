// enable.js —— 占位脚本（MV3）
//
// 历史说明：旧版本脚本负责"鼠标悬停高亮"，注册 mouseover/mouseout 监听器，
// 鼠标划过任何元素都会出现红色轮廓。这被用户视为 bug：
// 用户只期望"右键 Get Selector 选中元素后被红色虚线框标记"，
// 该功能已由 content.js 的 chromecssSelectorFinder class 实现（2px dashed #FF0000）。
// 因此本脚本不再注册任何监听器，仅保留注入钩子以兼容面板"恢复右键"按钮。

(function () {
  if (window.__cssSelectorFinderHighlightEnabled) {
    return;
  }
  window.__cssSelectorFinderHighlightEnabled = true;
  console.log('[CSS Selector Finder] enable.js 已注入（悬停高亮已移除，仅保留右键 Get Selector 高亮）');
})();
