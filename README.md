<p align="center">
  <img src="build/icon.png" width="112" alt="DS Station 图标">
</p>

<h1 align="center">DS Station 🐳</h1>

<p align="center">
  不用开浏览器，不用切网页<br>
  按一下 <kbd>⌥</kbd><kbd>Space</kbd>，就能快速向ai提问。
</p>



<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

<p align="center">
  <img src="docs/images/DSS_Introduction01.gif" alt="DS Station 快捷窗口演示" width="480">
</p>

---

## 它是什么

DS Station 把 DeepSeek 装进了快捷面板里，可以很方便的唤起使用。

它**不需要 API Key**，用你自己的 DeepSeek 账号就行，
消息记录只保存在 DeepSeek 那边，和网页版完全同步，应用不会存储、分享、分析你的任何信息。

---

## ⚡ 快捷窗口：把「问一句」的成本降到最低

### 一个键，它就出现 ⌥Space

不管你在写代码、看文档还是刷网页，按 <kbd>⌥</kbd><kbd>Space</kbd>，面板就浮到眼前。
不抢桌面、不切 App、不需要先找到浏览器标签页。


### 看着小，功能完整 ✨

功能和网页端几乎一致

- 回答**逐字流出**
- 生成中可以随时**停止**；也能**继续生成**
- 也能使用「深度思考」和「智能搜索」功能
- 创建「新对话」，很方便的另外开一个新对话

### 历史记录切换 📍

可以用面板中的「历史对话」随时切换到之前的任意对话。


---

## 🎛 其他

- **深浅色**可跟随系统，也可以在设置里锁定为浅色 / 深色；
- **呼出快捷键可改**：想换成自己的组合键，到设置里点一下重新录制
- **退出登录**：清掉本机登录态，聊天记录不受影响

---

## 📦 安装

1. 从 [Releases](../../releases) 下载最新的 `.dmg`
2. 打开 dmg，把 `DS Desktop` 拖进「应用程序」
3. 首次启动：在「应用程序」里**右键 → 打开**，再点一次「打开」

> 这个应用没有做 Apple 开发者签名和公证，所以系统会拦一下。
> 如果提示「已损坏」，只需在终端执行一次：
>
> ```bash
> xattr -cr "/Applications/DS Station.app"
> ```

---

## ⌨️ 快捷键

| 操作 | 快捷键 |
|---|---|
| 呼出 / 收起快捷窗口 | <kbd>⌥</kbd><kbd>Space</kbd> |
| 收起快捷窗口 | <kbd>Esc</kbd> |
| 历史对话 | <kbd>⌘</kbd><kbd>Y</kbd> |


---

## 🔒 隐私

- 不接入任何第三方 API，也不经过作者的服务器 —— 你的请求直接发往 `chat.deepseek.com`
- **不保存你的账号密码**，登录态只存在本机，由 macOS 的应用沙盒和 Electron 会话负责
- 不读取、不上传、不备份你的聊天记录
- 没有任何埋点，也不收集任何统计信息


---

## 📌 说明

本项目是个人开发的**非官方**客户端，与 DeepSeek 官方无关。

它的工作方式是驱动你自己登录的网页版 —— 不破解、不绕过登录，也不批量调用接口。
使用时仍需遵守 DeepSeek 的服务条款。

如果你觉得它好用，请Star；遇到问题欢迎反馈。

---

## 📄 License

[MIT](LICENSE) © 2026 SalvinTang
