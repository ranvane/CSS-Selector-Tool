# AGENTS.md —— 维护者手册

> 面向**改代码的人**。想知道**怎么用**请看 [README.md](./README.md)。
> 本项目与兄弟项目 `360-XPath-Tool` 同构（界面与交互完全一致，只是把 XPath 换成 CSS 选择器），
> 改一处逻辑时请同步对照那边，改动前务必读完本文第三节的「四职责契约」。

---

## 一、项目概述

Chrome 开发者工具扩展（Manifest V3），在 DevTools 面板里提取、编辑、分析 CSS 选择器。

- 形态：DevTools 扩展（非网页扩展），面板标题 `CSS Selector Finder`
- 运行时：面板页（`panel.js`）↔ background service worker（`background.js`）↔ 页面 content script（`content/content.js`）
- 语言：原生 JavaScript，无构建步骤、无依赖，改完刷新扩展即可

---

## 二、术语表（沟通与注释统一用这套词）

| 术语 | DOM id | 代码变量 | 说明 |
|---|---|---|---|
| **路径框** | `#selector` | `selectorEl` | 左侧 textarea，装 CSS 选择器，**可编辑** |
| **模式按钮** | `#toggle-btn` | — | `智能` / `原始` 切换按钮 |
| **恢复右键链接** | `#enablecon` | `enableEl` | 重新注入右键菜单 |
| **结果框** | `#results` | `resultsEl` | 右侧 `readonly` textarea，显示求值结果文本 |
| **节点计数** | `#node-count` | `nodeCountEl` / `nodeCountText` | `结果 (N):` 里的 N |
| **右键菜单项 Get Selector** | — | `MENU_ID` | 右键获取命中元素选择器 |

---

## 三、四职责契约（最重要，改动不得破坏）

| 单元 | 只做什么 | 明确**不**做什么 |
|---|---|---|
| **路径框** | 显示 CSS 选择器；用户可直接编辑 | 不自己发起任何动作，只被动接收写入 |
| **模式按钮** | 只处理**路径框当前里的**选择器 | 不碰右键缓存、不直接写结果框 |
| **结果框** | 实时显示路径框选择器的求值结果 + 节点计数 | 不发起求值，纯被动显示 |
| **右键 Get Selector** | 取命中元素的选择器，**覆盖**写入路径框（已有值先清掉，只留最新一条） | 不直接写结果框 |

### 数据流（单向，无环）

```
右键 Get Selector ──覆盖──┐
用户编辑路径框 ────────────┼──> 路径框 ──求值──> 页面 ──results──> 结果框 + 节点计数
模式按钮 ──处理当前选择器────┘
```

**唯一的收敛点**是 `content/content.js` 的 `sh.report_()`：所有求值与高亮都发生在页面侧，
所有回传都从这一个函数出去，`selector` 字段决定面板要不要覆盖路径框。

### 职责越界的三种典型错误（XPath 版都犯过）

1. ❌ 在 `panel.js` 里缓存右键结果、在模式按钮上来回切快照
   → 已废除。按钮必须对**路径框当前内容**现算（`transform` 命令）。
2. ❌ 让 `panel.js` 的 `render()` 在写完路径框后再发一次 `evaluateSelector`
   → 会多一次往返，并导致页面高亮被清掉再重绘一次（肉眼可见闪烁）。
   `update` 消息自带 `results`，写完就够了。
3. ❌ 绕过 `sh.report_()` 直接 `chrome.runtime.sendMessage`
   → 会漏掉 `clearHighlights()`，页面高亮 class 被反复叠加。

---

## 四、消息协议

### 面板 → background（`chrome.runtime.connect({name:'cssSelectorFinder'})`）

| command | 字段 | 作用 |
|---|---|---|
| `init` | `tabId` | 登记端口，把面板与被检查页绑定 |
| `evaluateSelector` | `selector`, `tabId` | 请求页面对选择器求值 |
| `transform` | `selector`, `mode`, `tabId` | 请求页面按模式现算并覆盖路径框，`mode` ∈ `smart` \| `original` |
| `enablecon` | `tabId` | 注入 `enable.js`（MAIN world） |

### background → 页面（`chrome.tabs.sendMessage`）

| command | 字段 | 处理函数 |
|---|---|---|
| `evaluateSelector` | `selector` | `sh.selector_ = selector` → `sh.report_(null)` |
| `transform` | `selector`, `mode` | `sh.transformSelector_(selector, mode)` |
| `getSelector` | — | `sh.report_(clickedEl ? makeSelectorForElement(clickedEl) : null)` |
| `clearHighlights` | — | `sh.clearHighlights()` |

### 页面 → background → 面板（`chrome.runtime.sendMessage`）

| command | 字段 | 面板处理 |
|---|---|---|
| `update` | `selector`（`string` \| `null`）, `results`（`[文本, 计数]`） | `selector != null` → 覆盖路径框；`results` → 写结果框与计数 |

**`selector` 字段是三态契约，写错就是隐蔽 bug：**

- `selector` 为具体字符串 → 覆盖路径框
- `selector` 为 `null` → **绝不碰路径框**，只刷新结果
- `selector` 为 `''` → 清空路径框

### background → 面板

| command | 作用 |
|---|---|
| `activatePanel` | 右键后自动切到 CSS Selector 面板 |

---

## 五、文件职责与改动指引

| 文件 | 职责 | 改什么动它 |
|---|---|---|
| `panel.js` | 面板 UI：路径框输入、模式按钮、结果框渲染、路径框撤销栈 | 交互、防抖、撤销/重做、按钮文字、面板布局 |
| `content/content.js` | 页面侧：选择器生成、求值、高亮、回传 | 选择器生成算法、缩写策略、高亮样式 |
| `background.js` | 右键菜单、消息路由、端口表 | 新增命令的路由、菜单项 |
| `devtools.js` | 面板创建、端口连接与断线重连 | 面板注册、生命周期 |
| `enable.js` | 占位脚本，保留注入钩子 | 目前无逻辑，勿加监听器 |
| `i18n/*/selector.html` | 三种语言的面板骨架与样式 | 文案、样式。**三份必须同步** |
| `_locales/*/messages.json` | 扩展名、菜单项、通知文案 | **两份必须同步** |

### 新增一条面板→页面的指令时

1. `panel.js` 发消息（记得在 `background.js` 的 `extensionListener` 里加分支，否则消息会被 `else` 原样回显到面板）
2. `background.js` 转发
3. `content/content.js` 的 `switch` 加 `case`
4. 页面侧统一用 `sh.report_()` 回传，不要另起 sendMessage

---

## 六、CSS 特有注意点（与 XPath 版不同，务必读）

1. **求值只有一种结果形态**。`document.querySelectorAll()` 只能返回元素集合，
   没有 XPath 的 `count()` / `string()` / 布尔 / 数字标量求值。
   所以 `sh.evaluateSelector()` 的结果固定是「命中元素 textContent 逐行拼接」，
   不要试图加 XPath 那套 resultType 分支。
2. **位置序号用 `:nth-child` 不用"同名同类计数"**。`sh.getChildIndex()` 统计的是
   父元素下**全部**元素兄弟的序号，这才是 `:nth-child` 的语义。
   直接照搬 XPath 版的 `getElementIndex()`（只数同名同类）会选错元素。
3. **id / class 必须转义**。`escapeIdent()` 用 `CSS.escape()`，
   否则 id 里含 `:`、`.`、空格时生成的选择器会被 `querySelectorAll` 抛异常。
4. **`querySelectorAll` 的非法输入包括伪元素**。`::before`、`::after` 会抛异常，
   已被 `evaluateSelector` 的 try/catch 兜住并显示 `[INVALID SELECTOR]`。
5. **智能缩写的每一级都校验唯一性**。第 4 步的 `#祖先锚点 标签` 必须查
   `querySelectorAll(...).length === 1` 才返回，不唯一就继续向上走，否则会给出命中多个节点的"智能"选择器。
6. **`:nth-child` 在"自己是第一个子元素"时也要输出**。只有独占父元素（无兄弟）时才省略。
   判据是"有没有兄弟"，不是"序号是否大于 1" —— 否则 `ul > li` 会同时命中所有 `li`。
   ⚠️ XPath 版用 `getElementIndex()` 在同类兄弟存在但自己是第一个时返回 1 并输出 `[1]`，
   移植时极易漏掉这条语义，本项目已踩过一次坑。
7. **生成选择器必须剔除高亮 class**。`sh.getClassList()` 过滤掉 `HIGHLIGHT_CLASS`。
   生成选择器时目标元素往往还带着高亮（`evaluateSelector` 刚加的），不过滤就会把
   `.chromecssSelectorFinder` 写进选择器，高亮一撤选择器立刻失效。
   ⚠️ **XPath 版有同一个 bug**（`makeQueryForElement` 直接读 `el.className`），
   表现为点「智能 / 原始」后路径框里出现 `[@class='... chromexPathFinder']`。
8. **class 列表走 `getAttribute('class')` 而非 `classList` 索引**。DOMTokenList 的索引属性
   并非所有环境可靠（实测 linkedom 下 `slice.call` 会得到 `[undefined]`），
   而 class 属性是规范保证的，且与 classList 始终同步。

---

## 七、已知的坑（别踩）

1. **防抖不能删**。`panel.js` 的 `onSelectorInput` 有 200ms 防抖。去掉后每敲一个字符都会触发
   `clearHighlights()` + 全量 `querySelectorAll()`，页面高亮疯狂闪烁。
2. **`render()` 里要清挂起的定时器**。用户正在打字时右键，会同时存在一个待触发的编辑求值；
   不清的话旧输入会在新选择器之后被求值并把结果覆盖回去。
3. **`sh.report_()` 里的 `clearHighlights()` 不能外提**。放外面的话将来新增调用点一定会漏。
4. **`sh.selector_` 与路径框必须始终一致**。页面侧 `sh.selector_` 是"当前生效选择器"，
   面板侧路径框是"显示内容"，两者由 `report_(displaySelector)` 保证同步。
5. **MV3 service worker 会被回收**。`background.js` 的 `ports` 表是内存态，
   丢了就靠 `devtools.js` 的 `scheduleReconnect()` + 重新 `init` 自愈，不要引入持久化。
6. **高亮 class 名改一处要改两处**。`content/content.js` 里的 `HIGHLIGHT_CLASS`
   与 `content/style.css` 里的 `.chromecssSelectorFinder` 必须一致。
7. **`panel.js` 的 `historyStack` 不能删**。浏览器的原生撤销栈帮不上忙：
   右键获取与模式按钮都会 `selectorEl.value = ...`，而程序化赋值会把 textarea 的
   原生撤销栈整个清空，且 JS 侧没有任何 API 能把它重建（实测 `Ctrl+Z` 与
   `document.execCommand('undo')` 均为空操作）。所以只能自管历史栈。
   同理，`applyHistory()` 里 `recordHistory()` **必须在越界检查之前**调用 ——
   否则「刚敲完 0.2 秒内就按 Ctrl+Z」会因为那笔输入还没进栈而越界落空。

---

## 八、代码规范

- **注释与文档字符串一律中文**，函数需写明输入、输出、业务功能（项目硬性要求）
- 使用 `var` 声明，保持 ES5 风格（content script 运行在页面上下文，兼容性优先）
- 关键逻辑流（分支、异常、循环）要有逐行中文注释
- 提交前跑 `node --check <文件>` 确认语法
- **不要引入与 XPath 版不同的架构**。若认为 XPath 版某处设计有问题，
  先改 XPath 版再同步过来，否则两个项目会越走越远。

---

## 九、更新日志

| 日期 | 变更 |
|---|---|
| 2026-09-26 | 项目创建。基于 `360-XPath-Tool` 同构移植：新增 `sh.makeSelectorForElement` / `sh.makeSmartSelectorForElement` / `sh.getChildIndex`；求值改用 `querySelectorAll`，输出固定为命中元素文本拼接（无标量求值）；id/class 走 `CSS.escape` 转义；高亮 class 改用 `classList.add/remove` 以兼容 SVG。相对 XPath 版的改进：扩展名与右键菜单项改用 `_locales` 国际化（XPath 版是硬编码中文） |
| 2026-09-26 | 用 linkedom 真实 DOM 跑了 37 项验证（round-trip 为主），修掉 3 个缺陷：① 生成选择器会带上自己的高亮 class `.chromecssSelectorFinder`（**XPath 版同 bug**）；② `:nth-child` 在"第一个子元素"时漏输出，导致 `ul > li` 命中全部 `li`；③ 智能缩写第 4 步不校验唯一性，会返回多命中选择器。另把 `getClassList` 从 `classList` 索引改为 `getAttribute('class')`，`clearHighlights` 从依赖 live NodeList 改为快照遍历 |
| 2026-09-26 | 验证套件扩到 93 项断言（`tests/highlight-verify.mjs`，Node + linkedom，无需浏览器），全部通过。新增「清高亮后表达式仍然命中」这一关键回归点，锁死高亮污染 bug 不再复发。初始化 Git 仓库（`main` 分支）并关联 `ranvane/CSS-Selector-Tool`；`.omo/`、`.codegraph` 写入 `.gitignore` |
| 2026-09-26 | **路径框新增撤销 / 重做**（`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`）。根因：右键获取与模式按钮都会写 `selectorEl.value`，程序化赋值会清空 textarea 原生撤销栈（实测原生 `Ctrl+Z` 与 `execCommand('undo')` 均失效），而该栈无法从 JS 重建。新增 `historyStack` / `historyIndex` / `recordHistory()` / `applyHistory()` / `onSelectorKeydown()`，把用户编辑与程序化覆盖一并记入历史；连续敲击在防抖落定时合并为一个撤销单位。新增 `tests/panel-undo-verify.mjs`（20 项断言，两个项目通用，自动识别 XPath / CSS 变体） |
