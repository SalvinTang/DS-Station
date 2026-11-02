DS Desktop 产品计划文档

版本：v1.0.0
名称：DS Desktop
平台：macOS
目标：Apple Silicon 优先
核心原则：不使用 DeepSeek API，全部 AI 对话通过 DeepSeek 官方 Web 完成。

1. 产品定位

开发一个轻量级 DeepSeek macOS 桌面客户端。

本质上不是重新实现 DeepSeek，而是：

“DeepSeek Web + macOS 原生桌面能力 + ChatGPT Classic 式快速召唤窗口”

应用本身不处理 AI 请求，不保存聊天内容，不实现账号系统。

用户登录 DeepSeek 后，所有聊天、历史记录、账号状态均由 DeepSeek Web 自己处理。

2. 核心目标

MVP 必须实现：

1. 独立 DeepSeek 主窗口
2. 使用 DeepSeek 官方 Web 页面
3. 用户可以正常登录 DeepSeek
4. 登录状态持久化
5. 正常显示历史聊天
6. 正常创建、查看、继续聊天
7. 全局快捷键呼出快速窗口
8. 快速窗口可以直接输入并进行 DeepSeek 对话
9. 主窗口和快速窗口共享登录状态
10. macOS 原生桌面体验

不实现：

1. DeepSeek API
2. 自建后端
3. 用户账号系统
4. 自己保存聊天记录
5. 自己实现 AI 请求
6. 自己实现 Markdown 渲染
7. 自己实现流式输出
8. 自己复制 DeepSeek 聊天 UI

3. 技术方案

推荐技术栈：

Electron
TypeScript
HTML/CSS
WebContentsView
Electron Session
Electron globalShortcut
electron-builder

核心原因：

DeepSeek 页面直接由 Chromium 渲染，不需要自己重新实现聊天功能。

Electron 官方目前推荐 WebContentsView 用于嵌入第三方 Web 内容，并且 BrowserView 已被 WebContentsView 替代。 

不要使用 Electron <webview> 标签。Electron 官方目前不推荐继续使用该方案。 

4. 整体架构

DeepSeek Desktop
│
├── Main Process
│   ├── Window Manager
│   ├── Session Manager
│   ├── Global Shortcut Manager
│   ├── Settings Manager
│   └── IPC
│
├── Main Window
│   └── WebContentsView
│       └── DeepSeek Web
│
├── Quick Window
│   └── WebContentsView
│       └── DeepSeek Web
│
└── Persistent Session
    └── DeepSeek Cookie / Login State

两个窗口使用同一个持久化 Electron Session。

Electron 的 persist: partition 可以让多个页面共享持久化 Session，因此主窗口和快速窗口可以共享 DeepSeek 登录状态。 

5. DeepSeek Web

默认 URL：

https://chat.deepseek.com/

原则：

尽可能让 DeepSeek Web 自己完成所有功能。

不要主动解析或复制：

聊天记录
用户信息
模型信息
回答内容
Token
Cookie
登录信息

除非某项桌面功能确实需要，否则不要注入 JavaScript 修改 DeepSeek 页面 DOM。

原因：

DeepSeek 页面未来可能发生 UI 或前端代码变化。

尽量减少对页面内部结构的依赖，提高长期稳定性。

6. 主窗口

主窗口是完整 DeepSeek 使用环境。

目标体验：

┌────────────────────────────────────────────┐
│ DeepSeek Desktop                           │
├──────────────┬─────────────────────────────┤
│              │                             │
│ 历史对话      │                             │
│              │        DeepSeek Web          │
│ 对话 1       │                             │
│ 对话 2       │                             │
│ 对话 3       │                             │
│              │                             │
│              │                             │
└──────────────┴─────────────────────────────┘

MVP 不重新制作左侧历史记录。

直接显示 DeepSeek 官方 Web 页面。

应用只负责：

窗口
尺寸
位置
最小化
关闭
恢复
macOS 菜单
快捷键
Session

7. 快速窗口

这是本产品的核心特色。

默认快捷键：

Command + Space

但必须允许用户修改。

Electron globalShortcut 可以注册系统级全局快捷键，即使应用当前没有焦点也可以触发。 

快速窗口：

┌────────────────────────────────────┐
│ DeepSeek                           │
├────────────────────────────────────┤
│                                    │
│ 请输入问题……                         │
│                                    │
│                                    │
│                          发送       │
└────────────────────────────────────┘

要求：

1. 小尺寸
2. 居中或接近屏幕顶部
3. 圆角
4. 无明显系统窗口边框
5. 始终位于其他窗口上方
6. 呼出后自动获得输入焦点
7. 再次快捷键隐藏
8. 点击外部区域可隐藏
9. Escape 隐藏
10. 不关闭 Web Session

8. 快速窗口的实现原则

快速窗口不要自己实现聊天接口。

优先方案：

Quick Window
    ↓
WebContentsView
    ↓
DeepSeek Web

快速窗口和主窗口使用相同 Session。

                 persist:deepseek
                       │
              ┌────────┴────────┐
              │                 │
        Main Window        Quick Window
              │                 │
        DeepSeek Web       DeepSeek Web

这样用户在主窗口登录后，快速窗口自动使用同一登录状态。

9. 登录系统

不开发自己的登录系统。

流程：

第一次启动
    ↓
DeepSeek Web
    ↓
用户登录
    ↓
DeepSeek 建立 Session
    ↓
Electron 持久化 Session

以后：

启动 App
    ↓
加载持久化 Session
    ↓
自动进入 DeepSeek

不要：

保存 DeepSeek 密码
自己提交登录请求
自己管理 DeepSeek Token
自己模拟登录接口

10. 数据策略

本应用原则上不保存用户的 DeepSeek 数据。

本地只保存应用配置，例如：

快捷键
主窗口尺寸
主窗口位置
快速窗口尺寸
快速窗口位置
应用设置

DeepSeek 登录状态由 Electron Session 保存。

DeepSeek 聊天记录由 DeepSeek Web/DeepSeek 服务保存。

不要建立自己的聊天数据库。

11. 项目目录

推荐：

deepseek-desktop/
│
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── windows.ts
│   │   ├── main-window.ts
│   │   ├── quick-window.ts
│   │   ├── session.ts
│   │   ├── shortcut.ts
│   │   ├── settings.ts
│   │   └── menu.ts
│   │
│   ├── preload/
│   │   └── index.ts
│   │
│   └── renderer/
│       ├── settings/
│       └── styles/
│
├── assets/
│   └── icons/
│
├── package.json
├── tsconfig.json
└── electron-builder.yml

当前阶段没有真正需要 Renderer，可以尽量减少 Renderer 代码。

12. 窗口管理

需要维护：

mainWindow
quickWindow

主窗口：

可正常调整大小
可最小化
可关闭
关闭后 App 可继续驻留

快速窗口：

隐藏
显示
聚焦
失焦隐藏
Escape 隐藏
快捷键隐藏

快速窗口隐藏时不要销毁 WebContents。

这样可以避免每次呼出都重新加载 DeepSeek。

13. App 生命周期

推荐：

启动 App
    ↓
初始化 Session
    ↓
创建主窗口
    ↓
加载 DeepSeek Web
    ↓
注册全局快捷键
    ↓
等待用户操作

关闭主窗口：

主窗口关闭
    ↓
App 保持运行
    ↓
Command + Space
    ↓
快速窗口仍然可以呼出

最终可以增加 macOS Menu Bar 常驻模式。

14. 快捷键

MVP：

Control + Space

功能：

显示 / 隐藏 Quick Window

预留：

Escape
隐藏 Quick Window

后续：

自定义快捷键

注意：

Control  + Space 可能被占用，因此必须检测注册是否成功。

如果快捷键注册失败，不应该导致 App 启动失败。

Electron 在快捷键已经被其他程序占用时会注册失败。 

15. 设置

MVP 设置尽量少。

设置
快速窗口快捷键
[ Control  + Space ]

启动行为
[ ] 开机启动






16. 安全要求

必须遵守：

1. Node.js 权限和网页权限严格隔离
2. 不向 DeepSeek 页面暴露 Node.js API
3. 不关闭 Web Security
4. 不保存用户密码
5. 不主动读取 DeepSeek Cookie 内容
6. 不把聊天数据发送到第三方服务器
7. 不建立自己的 AI Proxy
8. 不上传用户聊天内容

原则：

“DeepSeek Web 是不可信的远程网页内容，桌面 App 的本地能力必须与其隔离。”

17. 网络要求

应用本身不需要 AI API。

所有 AI 网络请求由 DeepSeek Web 发起。

因此：

App
 ↓
DeepSeek Web
 ↓
DeepSeek Server

如果用户使用代理/VPN，应尽量让 Electron/Chromium 遵循系统网络环境。

不要在 MVP 阶段自己实现代理系统。

18. 错误处理

需要处理：

DeepSeek 无法访问
网络断开
登录失效
页面加载失败
快捷键注册失败
Session 损坏
窗口创建失败

例如：

DeepSeek 无法连接
请检查网络连接。
[重新加载]

不要尝试自己模拟 DeepSeek API。



20. MVP 验收标准

满足以下条件即认为 MVP 完成：

[ ] App 可以正常启动
[ ] 主窗口可以打开 DeepSeek Web
[ ] 可以在 App 内正常登录
[ ] 登录状态重启 App 后仍然存在
[ ] DeepSeek 历史聊天正常显示
[ ] 可以创建新对话
[ ] 可以正常发送消息
[ ] 可以正常接收流式回答
[ ] Control  + Space 可以呼出快速窗口
[ ] 快速窗口可以直接输入
[ ] 快速窗口可以正常进行对话
[ ] 主窗口和快速窗口共享登录状态
[ ] Escape 可以关闭快速窗口
[ ] 快速窗口隐藏后再次打开无需重新加载
[ ] App 不使用 DeepSeek API
[ ] App 不需要用户填写 API Key
[ ] App 不保存用户密码
[ ] App 不需要自己的服务器






