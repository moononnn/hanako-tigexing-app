# 提个醒 · 自动测试与实机验证

当前发布候选：`0.1.1`（2026-10-13；仅修复版本）

## 完成提醒发送前复检（2026-10-26，本地开发）

- 现场：Code 窗口的「子代理隔离知意注入」会话弹了一条「〔Code〕子代理隔离知意注入 · 小花回你啦！」。debug.log 时间线：`04:53:32.870` turn_end（stop，最终回合）判「说完了」→ `04:53:35` 分区查询（失败，Session manifest not found）→ `04:54:29` 通知文案才生成 → `04:54:33` 提交成功 → `04:54:44` 会话又开始动，`04:55:28` 起又是 turn_end + toolUse。判定后用 61 秒（其中润色约 54 秒，模型 `MiniMax-M3.1-Flash-Preview`，首次 20 秒超时、重试后成功）。
- 判定本身不错：当时没有后台任务（子代理 `04:49:39` 已结束）、没有欠着的叫醒。错在发送与判定分了家，中间没有回头确认会话还闲不闲。对比：`handleAbnormalAlert` 的「空返回」提醒已有同类「过时」检查，完成提醒主路径没有。
- 修复（按玥儿要求只做复检，不动润色预算）：`index.js` 新增 `turnStarts`（会话 → 最近开工时间戳）与 `staleSinceJudgement()`；`doToast` 加第四参 `judgedAt`，在 `notify()` 前一瞬检查是否已开工（turn_start / 后台任务 / 叫醒欠账），命中就丢弃并 `dbg('通知已过时（…），不弹')`；主路径与合并补弹都传基准时刻；`session_closed` 里清 `turnStarts`。
- 基准时刻用 `handleTurnEnd` 里那个 `now`（回合到达时取），不是进入 `notifyTurnEnd` 时取：中间「是否在前台」那一步会 `await` 让出，turn_start 可能已插入，晚取的基准会把开工当成「之后才发生」而拦不住（这个差别是先写成 `Date.now()` 后、测试第 4 条拓出来的）。
- 定向命令：`node --test tests/stale-notify.test.js`，**4/4 通过**（判定后开工作废 / 后又起后台任务作废 / 对照照常提醒 / 开工后那轮说完仍提醒）。全量：`node --test`，**497/497 通过**。
- 未验证：没有在真实慢模型 + 真弹窗的组合下重演一次；复现需要润色恰好超过 20 秒且期间窗口开工，靠实机碰到再说。

## 文案截断切碎 emoji（2026-10-26，本地开发）

- 现场：Code 窗口弹窗正文尾部出现一个「�」方块。日志反查 `app-data/tigexing-app/tigexing/debug.log` 12:21:31 那条，`body` 是 `半个emoji被截断啦！已修好，重载后提醒提交\ud83c…`，孤立高位代理摆在明处。
- 成因：润色正文 `BODY_MAX = 24`，`String#slice` 按 UTF-16 单元切，emoji 占两个单元。23 字正文 + 一颗 emoji = 25 单元，切在第 24 位正好劈开代理对；孤立代理经 PowerShell 环境变量传参编码后变成 `U+FFFD`。
- 修复：新增 `lib/text-clip.js`（`clipCodePoints`，`Array.from` 按码点切），接进四处可见文案截断：`refine.js` clipText、`style.js` clip 兜底与 sessionPrefix、`policy.js` makeSnippet。中文长度与旧行为一致，emoji 不会再被劈开。
- 定向命令：`node --test tests/text-clip.test.js`，**6/6 通过**。全量：`node --test`，**493/493 通过**。
- 实机验证：修前 `slice(0,24)` 产出 `…改哦！\ud83c…`（孤立代理 true），修后 `clipCodePoints` 产出完整整句带 🌿（孤立代理 false）；用 `sendToast` 直发一条自测通知，`sent: true`，弹窗尾巴是整颗小草，无方块。
- 已知边界：ZWJ 组合 emoji（如 👨‍👩‍👧）仍会在码点边界被拆开，结果是视觉上少半个人，不会变成替换字符。

## Code 窗口提醒分隔（2026-10-25，本地开发）

- 定向命令：`node --test tests/session-kind.test.js tests/notification-title-order.test.js`，全过。全量：`node --test`，**483/483 通过**（原先 472，新增 11 条）。
- 覆盖的新口径：namespace=code 认作 Code 窗口、无 sessionId 时按路径查、事件里的 sessionId 是会话文件名要先失败再改走 legacySessionPath、查询失败不抛错也不缓存失败、同一会话只查一次、Code 那两栏走白名单且空 id 条目丢弃、旧配置自动补成空对象（全部跟随普通）。
- 实机确认（2026-10-25）：`session:get` 返回的 `namespace` 能区分 home / code / app；两个 Code 页会话实测都是 `namespace=code`；`session:list` 的 70 条里一条 Code 会话都没有，字段（path/title/kind/visibility/ownerPluginId）无一项能区分。
- 未验证：真实 Code 窗口跑完一轮后横幅实际长什么样、以及 Code 专用音效在真机上的播放效果；这两项要靠实机弹窗验收，自动测试证明不了。
- 已知边界：判不出分区时一律按普通窗口处理（宁可不标记号，也不误标）。单条提醒最多多两次 `session:get`（命中缓存就只有 0 次），超时 2.5 秒。

## 通知主腿可靠性与图标校正（2026-10-18，本地开发）

- 定向命令：`node --test tests/toast-delivery.test.js tests/toast-duration.test.js tests/app-smoke.test.js tests/focus-notify.test.js tests/external-notify.test.js tests/debug-log.test.js`，**48/48 通过**。新增两条覆盖：超时重试一次后拿到标记即算成功、脚本明确报错不重试直接降级。
- `node --check lib/toast.js index.js` 通过；`lib/notify.ps1` 实机跑通（443ms，回 TXS_TOAST_SUBMITTED），并确认注册表 IconUri 已从不存在的旧安装路径校正为当前 `assets/icon.png`。
- 未跑全量；未调用真实模型或外部 API。真实机器繁忙场景下的 45 秒上限是否足够，需要等下次实况再验。
- 宿主备用通道**注定没有伙伴头像**：`AppNotificationInput` 契约只有 title/body，不接受 icon。这次只能降低走它的概率，不能消除。

## 拾光记专注通知联动（2026-10-14，本地开发）

- 定向命令：`node --test --test-reporter=tap tests/focus-notify.test.js tests/external-notify.test.js tests/notification-copy.test.js tests/app-smoke.test.js`，**30/30 通过**。覆盖伙伴风格与主伙伴回退、实际陪读者姓名、独立专注通用通知、静默、并发幂等、调用方白名单、服务与 capability 声明。
- `index.js`、`lib/focus-notify.js`、两个相关测试文件 `node --check` 通过。未跑全量；未调用真实模型或外部 API。
- 重装后 `app/services.provide` 权限审核已通过，提个醒已从正式入口 reload，inspect 为 `host=on / agent=on`。自动测试与加载状态都不等于真实跨 App 调用或 Toast 显示已验收；本次尚未触发真实专注通知。

## 怎么跑

全量自动测试（在源码根目录，**不加名单**）：

```powershell
node --test
```

Node 会自己递归去找用例：顶层 `tests/` 里的测试文件，加上积木自带的 `lib/update-checker/tests/`、`lib/model-config/tests/`、`lib/feedback/tests/`。

**不要写 `node --test tests/*.test.js`**：那样只跑顶层目录，积木自带的那三份用例会被漏掉，绿灯是虚的。这一点在别的应用上已经吃过一次亏，这里沿用同一口径。

只跑受影响的部分（改哪儿测哪儿）：

```powershell
node --test tests/policy.test.js tests/style.test.js tests/notification-copy.test.js
```

全部 JavaScript 的语法检查：

```powershell
Get-ChildItem -Recurse -Filter *.js -File | ForEach-Object { node --check $_.FullName }
```

宿主静态校验（用 Hana 自带的脚本，版本号按当前安装的宿主填）：

```powershell
node "<HANA_HOME>\artifacts\server\<宿主版本>\scripts\validate-app.mjs" --dir "<App 源码目录>" --json
```

必须读取非空的结构化结果（`ok: true`、错误数、警告来源），**只看退出码不算通过**。

## 测试覆盖什么

- **事件解析**：回合结束、中断回合、用户主动打断后重发、后台任务开始与结束、会话生命周期事件。
- **模型异常提醒**：provider error / 失败回合 / 重试开始与耗尽接线、失败去重、额度与 Token Plan 原因识别、未知原因脱敏、手动停止不误报、断联独立开关、**静默收尾（正常 stop 但无正文无工具调用）单独认作异常候选**。
- **后台任务门与补发**：子agent 运行时压住完成提醒、收齐后补发且只补最后一条、没压下就不补；漏掉 remove 时按 TTL 兑底释放、长任务靠新事件续命、会话关闭清账。
- **补发静默期**：收齐后不立即弹，先静默一段时间；静默期内窗口又开工则补发作废（暂存一并丢弃，不补发也不堆内存）；会话关闭取消排期。已知残留两条用测试写实：补发取消后新回合被打断则一条都不弹；开工晚于静默期会先弹一条已被取代的过程句。
- **提醒策略**：四档聊天提醒时机、按伙伴单独设的档位、静默时段（含跨午夜）、合并窗口与补弹、隐藏名单。
- **计划任务 / 巡检提醒**：cron 与 heartbeat 解析、各自档位、计划任务接管开关、静默时段、宿主原版通知去重和标题/正文组装。
- **真实参与判定**：只有用户真的开过口的会话才提醒；参与标记持久化、重载恢复、损坏档案不覆盖、保存失败仍保留本次事实。
- **会话标题**：稳定 id 与路径两种定位、显式 scope、异步标题事件不丢、查询重试与等待上限、读不到时不编造。
- **通知装配**：正文先生成、标题后附加的顺序，规则版与润色版不重复加前缀。
- **文案风格**：每套风格的标题与正文组装、方言与「学我说话」的扩展注册、未装表情包时静默降级。
- **润色与预算**：提示词要求真改写、思考与正文预算、同模型有界重试、失败回退规则文案、不静默换模型。
- **弹窗投递**：子进程提交确认、失败与超时、宿主备用通道、四个入口走同一条投递路径、界面不把「发起」说成「已显示」。
- **资源与安全**：头像解析的兜底、音效路径与扩展名校验、越界路径不被采用。
- **设置页与接口**：页面与接口的装配、页面断言与接口断言分开、各入口装载。
- **模型配置**：候选模型列表、保存的 provider/model、指定模型测试、Key 存储状态。
- **更新检查与反馈**：版本比较、网络失败降级、反馈会话与草稿组装（这两个入口还要接应用的出网白名单，见 README 的「已知边界」）。

## 本版测试状态

- 2026-10-17 静默收尾定向测试：**相关 138/138 通过**（`node --test tests/event-parse.test.js tests/abnormal-copy.test.js tests/abnormal-state.test.js tests/deferred-notify-flow.test.js tests/policy.test.js tests/app-smoke.test.js` 107 条 + `tests/wait-debt-flow.test.js tests/background-tasks.test.js tests/deferred-turns.test.js` 22 条 + `tests/toast-delivery.test.js` 9 条）。未跑全量、未跑真实付费模型。新增：空返回解析的四组边界（说话/调工具/标准失败/主动打断/长度截断均不误杀）、「这轮没出声」文案不编错误码、端到端空回合提醒只弹一次且不冒充正常完成、断联开关关闭时不弹、后台任务压着时不抢弹。
- 本版全量自动测试：**423/423 通过**（`node --test`，2026-10-13；新增空内容完成事件端到端回归：空内容不通知，后续非空回复仍正常提醒）。注意：该条的空内容语义已被 2026-10-17 修正——空返回现在会弹一条异常提醒，不再完全静音。
- 上一版 v0.0.21 全量自动测试：**415/415 通过**（发布预检记录）。
- 本次模型异常提醒相关定向测试：**63/63 通过**（`node --test tests/abnormal-copy.test.js tests/abnormal-state.test.js tests/event-parse.test.js tests/deferred-notify-flow.test.js tests/app-smoke.test.js`；包含 Token Plan 402/2067 原因、五小时额度识别、未知原因脱敏、失败提醒、重试耗尽、开关关闭、手动停止过滤和入口装载）。未调用真实付费模型。
- 模拟实机路径：用临时数据目录注入合成 402 provider error，经过当前 `apply()`、生产 `sendToast` 与 `notify.ps1`；日志记录 `kind=failure via=powershell`，无宿主备用通道，Windows 已接受提交，横幅可见性经截图确认。测试静音，未触碰正式偏好，也未调用真实模型/API。
- 0.0.21 定向自动测试：**142/142 通过**（后台任务追踪与超时兜底、暂存队列与过期丢弃、端到端补发链路、兵底释放的提醒与不重复补发、合并窗口写 0 的回归、事件解析、应用装载、焦点策略、弹窗投递、提醒策略、配置、通知文案、活动通知、参与记录与回合轨迹）。
- 实机验收：**正常提醒路径已实机确认**（头像、豆狸粒狸风格、专属音效、文案润色均正常，2026-10-12；2026-10-13 重载后当前对话的非空回复再次经 PowerShell 成功提交）；**补发与超时兜底路径未实机验证**（需真机上制造后台任务结束通知丢失，尚未做）。
- 0.0.19 活动提醒改动的定向测试：**65/65 通过**（事件解析、活动通知文案/去重、配置、焦点策略与应用装载；2026-10-11）。
- 语法检查：发布预检会对全部 JavaScript 文件跑 `node --check`。
- 宿主静态校验：发布预检单独跑，读取非空结构化结果。
- 实机验收：见下面「已经实机确认的」与「还没实机确认的」，两栏分开写，不互相顶替。

### 已经实机确认的

- 应用能在当前宿主里装载、设置页能打开、配置能保存。
- 通知能通过子进程提交并弹到 Windows 桌面（含头像与音效链路）。
- 指定模型测试能连通（走宿主模型接口，不读宿主的模型配置目录）。
- 计划任务与巡检提醒：真实计划任务和自动巡检场景均已分别实测，提醒链路正常（2026-10-12）。

### 还没实机确认的

- 新建窗口的**第一条**通知是否都带上会话标题（标题由宿主异步生成，这条一直在观察）。
- 合成 402 错误已走过 `apply()` 到生产 Windows Toast 脚本，且有截图确认横幅可见；**真实供应商再次失败的自然回合仍未重放**。宿主若没给具体错误文本，只会显示通用原因。
- 宿主原版通知去重依赖活动会话路径匹配；当前真实场景实测正常，尚未穷尽所有路径与设置组合，路径不匹配时仍可能按档位补弹。
- 检查更新与反馈：接口在，出网白名单没接，入口暂时不可用。
- 方言风格：需要插件版表情包的目录仍在原位置。

## 不能靠自动测试证明的事

自动测试覆盖的是逻辑与装配。下面这些只有实机能回答，任何一次「测试全绿」都不等于它们成立：

- Windows 横幅在不同免打扰、专注模式与系统通知设置下是否都能显示；当前提醒场景已实测正常，系统设置仍可能拦截其他场景的横幅。
- 音效是否真的响得出来。
- 弹窗子进程能否真的读到授权目录里的头像和音频。
- 权限没批准、被撤销时的降级表现是否仍然体面。
- 通知延迟在真实使用里能不能接受（润色开启时会等模型）。
