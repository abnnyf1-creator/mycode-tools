# MyCode 开发工具

一个 VSCode / Code-OSS 侧边栏扩展：把「本地项目启动打包」「云服务器运维」「站点后台入口」收进同一个面板，全部点按钮完成，命令自动注入集成终端，不用打开命令面板、也不用背命令。

> 面向个人多项目开发场景：十几个项目散落在一个根目录下，每个项目启动/打包命令各不相同。这个扩展负责自动探测出这些命令，并给出「凭什么这么判」的依据。

## 功能

面板分三个页签：

### 项目（默认）

- **项目列表**：展示根目录下探测到的全部项目，标注技术栈（flutter / godot / cmake_cpp / python / node / rust / go / android / static / vscode_fork）。
- **一键操作**：每个项目按实际结构生成按钮，常见为「源码启动」「打包分发」「打包 Web / 打包 APK」「文档 / 官网资料」「打开目录」。
- **探测依据可见**：每个按钮下方直接写明判断依据——依据哪个文件（如 `pubspec.yaml`、`CMakeLists.txt`、`tools/build.sh`），用的是哪条工具链路径（如 `<项目根>/devDependencies/flutter/bin/flutter.bat`）。
- **复用终端**：同一项目的命令进入同一个命名终端，重复点不会开一堆终端；底部「中断 (Ctrl+C)」可直接掐断正在跑的任务。
- **自动发现**：监听项目根目录，新建/删除项目文件夹时增量更新面板；**不会覆盖你手工改过的已有项目命令**。

### 运维

按项目里真实存在的部署脚本（如 `deploy/`、`MIGRATION_RUNBOOK.md`）探测出服务器条目，包含 host / user / port / 私钥路径。支持：

- 「连接」建立交互式 SSH 终端
- 「查看状态」「查看日志」「重启服务」「卡密统计」等按服务实际命令下发的操作
- 「断开」释放对应终端

### 会员后台

把管理后台、官网、发卡平台、License API 等入口收成一组按钮，点一下用默认浏览器打开对应 URL。

## 技术栈探测规则

扫描器（`scanner.js`，`SCANNER_VERSION = 2`）按以下优先级判定，先命中先停：

| 命中文件 | 判定 |
|---|---|
| `pubspec.yaml` | Flutter |
| `settings.gradle.kts` 或 `gradlew.bat` + `app/build.gradle.kts` | Android (Gradle) |
| `project.godot` | Godot |
| `run.py` 或 `UserFeedback.spec` | Python（PyInstaller 打包） |
| `code-oss/product.json` 或存在 `VSCode-win32-*/` 构建目录 | VSCode 派生版 |
| `CMakeLists.txt` | CMake / C++ |
| `package.json` | Node |
| `Cargo.toml` | Rust |
| `go.mod` | Go |
| `pyproject.toml` / `requirements.txt` / `main.py` / `app.py` | Python 通用 |
| `index.html` | 静态站点 |
| 以上都没有 | 未知（仅保留打开目录） |

工具链探测会按固定候选路径 + PATH 查找 flutter、msys bash、cmake、godot、python、node/npm、cargo、go、dotnet、gradle、java，命中的绝对路径会写进配置并显示在面板上。

## 安装

### 方式一：直接拷贝（最简单）

把整个 `mycode-tools` 目录复制到扩展目录，重启窗口：

```powershell
Copy-Item -Recurse -Force `
  "<扩展源码目录>" `
  "$env:USERPROFILE\.vscode\extensions\creatoride.mycode-tools-1.0.0"
```

### 方式二：作为 Code-OSS 内置扩展

放进 `code-oss/extensions/` 后重新构建 Code-OSS 即可随 IDE 一起分发。

## 使用

1. 打开左侧活动栏的 **MyCode 开发工具** 图标。
2. 首次打开时若没有配置，扩展会自动扫描一次并生成配置（写进扩展的 globalStorage 目录）。
3. 点项目 → 直接点按钮。命令会在集成终端里执行，输出实时可见。
4. 结构变了（新建项目、加了构建脚本）→ 点底部「重新探测项目结构」。
5. 想手工定制命令 → 点「编辑配置」改 JSON，保存后面板自动刷新；只要配置里带 `scanned_at`，重新探测就不会覆盖你的修改。

## 配置

配置文件：`mycode_config.json`，默认位于扩展 globalStorage，可用设置项指向自定义路径。

设置项（`settings.json`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `mycodeTools.configPath` | `""` | 自定义配置文件路径；留空用扩展数据目录下的那份 |
| `mycodeTools.projectsRoot` | `""` | 项目根目录，重新探测时扫描它下面所有项目；留空则用用户目录下的 `Projects` |
| `mycodeTools.autoDetect` | `true` | 监听根目录，项目文件夹增删时自动更新面板 |

配置文件结构（已脱敏示例见 [`mycode_config.example.json`](./mycode_config.example.json)）：

```jsonc
{
  "projects_root": "D:/Projects",
  "scanner_version": 2,
  "scanned_at": "2026-11-09T02:36:16.522Z",
  "toolchain": { "flutter": "…", "cmake": "…", "python": "…" },
  "projects": [
    {
      "id": "DemoApp",
      "name": "DemoApp",
      "tech": "flutter",
      "platform": "windows",
      "path": "D:/Projects/DemoApp",
      "structure": ["pubspec.yaml", "windows/CMakeLists.txt", "docs"],
      "functions": [
        {
          "key": "launch",
          "label": "源码启动",
          "type": "run",              // run | open | url | note
          "cmd": "call \"…/flutter.bat\" run -d windows",
          "evidence": "pubspec.yaml + windows/CMakeLists.txt"
        }
      ]
    }
  ],
  "servers":   [ { "id": "…", "name": "…", "host": "…", "user": "…", "port": 22, "key": "…", "functions": [] } ],
  "admin_sites": [ { "id": "…", "name": "…", "url": "https://…" } ]
}
```

`functions[].type` 取值：

- `run` — 在本地/SSH 终端执行 `cmd`
- `open` — 打开本地文件或目录
- `url` — 用浏览器打开 `url`
- `note` — 只展示说明文字，不执行

## 项目结构

```
mycode-tools/
├── extension.js          # 扩展入口：激活、命令注册、webview 面板与消息处理
├── scanner.js            # 项目/工具链/服务器探测（SCANNER_VERSION 2）
├── mycode_config.json    # 生成的配置（已 .gitignore，不入库）
├── mycode_config.example.json  # 脱敏示例
├── media/mycode.svg      # 活动栏图标
└── package.json          # 扩展清单（视图、命令、设置项）
```

## 已知限制

- **Windows 优先**：命令模板大量使用 `call`、`.bat`、`C:/msys64/...` 这类 Windows 写法，Linux/macOS 上需要自己改命令。
- **工具链路径靠探测**：候选路径写死在 `scanner.js` 里（如 `C:/msys64/mingw64/bin/cmake.exe`），换机器后要重新探测或手工改配置。
- **服务器探测基于项目内脚本**：没有部署脚本的项目不会被识别成服务器条目。
- **配置含真实地址**：生成的配置会包含本机绝对路径、服务器 IP 与账号，默认被忽略，不要直接提交。

## 许可

MIT，见 [LICENSE](./LICENSE)。
