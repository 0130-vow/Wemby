# Wemby

一个个人自用的 Windows Emby 客户端原型，目标是：界面轻、启播快、播放稳定、拖进度条顺手。

## 技术路线

- Electron 做桌面壳和媒体库 UI。
- Emby REST API 负责登录、媒体库、搜索、详情和播放进度同步。
- mpv 负责实际播放，优先使用直连流，降低转码概率。
- mpv 使用 `--wid` 嵌入 Electron 子窗口，JSON IPC 负责暂停、快进和状态同步。

## 运行

```powershell
npm.cmd install
npm.cmd start
```

如果 PowerShell 阻止 `npm` 脚本，使用 `npm.cmd`。

`npm.cmd install` 会自动准备内置 mpv 到 `vendor/mpv/mpv.exe`。如果只想重新准备 mpv，可以运行：

```powershell
npm.cmd run prepare-mpv
```

## 打包和发布

本地生成 Windows 安装包和 portable exe：

```powershell
npm.cmd run dist:win
```

产物会输出到 `release/`。发布 GitHub Release 时，推送一个版本 tag 即可触发自动构建和上传：

```powershell
git tag v0.1.4
git push origin v0.1.4
```

GitHub Actions 会生成 NSIS 安装包和 portable exe，并附加到 Release。

## mpv

Wemby 会自动准备内置 mpv。安装依赖时会从 zhongfly/mpv-winbuild 的 GitHub Release 下载适合 Windows 的 mpv，并解压到项目内 `vendor/mpv/mpv.exe`。如果运行时仍没有找到 mpv，应用会再下载一份到用户数据目录作为兜底。

应用查找 mpv 的顺序：

1. 设置页填写的 `mpv.exe` 完整路径
2. Wemby 自动准备的内置 mpv
3. `vendor/mpv/mpv.exe`
4. 系统 `PATH` 中的 `mpv.exe`

设置页里的 mpv 路径通常可以留空；只有你想指定自己的 mpv 版本时才需要填写。

## 第一版能力

- Emby 用户名密码登录
- 首页：媒体库、继续观看、最新入库
- 搜索电影、剧集、单集
- 查看详情和剧集列表
- 在应用内嵌 mpv 播放电影/单集
- 播放器基础控制：暂停/继续、快退 10 秒、快进 30 秒、停止
- 向 Emby 上报播放开始、进度和停止

## 产品迭代建议

1. 起播优化：对局域网服务器默认直连；增加“强制转码/强制直连/码率上限”开关。
2. 拖动优化：增加应用内进度条，UI 层只发 seek 命令，不接管解码链路。
3. 字幕体验：做音轨/字幕轨选择、外挂字幕搜索、字幕偏移快捷键。
4. 多配置：支持多个 Emby 服务器、多个用户、局域网/公网地址自动切换。
5. 全屏体验：播放器视图增加应用内影院模式和 mpv 原生全屏切换。
6. 分发：加入 electron-builder，打包成 Windows 安装包或 portable exe。
