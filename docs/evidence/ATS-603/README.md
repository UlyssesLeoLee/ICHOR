# ATS-603 ｜ Android 模拟器 Runner 原型与真实设备冒烟 ｜ 证据

本目录是 ATS-603 的**实测证据**。每一份日志的头部都写明它所描述的**树**
（`tree:` / `branch:` / `when:`），所以每一份日志都能被核对到它对应的那次提交。

**这些证据全部采自合并回 `dev` 之后的树**（不是开发分支，不是临时副本）。

## 测到了什么

| 步骤 | 断言 | 证据 |
|---|---|---|
| 启动 App | 应用进入前台，包名与预期一致 | `03-device-it.log`（IT-ATS603-010 / 020）：`foreground.package=com.ichor.smoke` |
| 点按元素 | 目标元素被点中（后续状态可观察） | `03-device-it.log`（IT-ATS603-011 / 020）：点按后第二屏出现 |
| 断言可见 | 元素确实可见；不可见时给出元素名而非泛化失败 | `03-device-it.log`（IT-ATS603-012 / 020）：失败时点名元素并附当屏层级树 |
| 截图 | 截图文件落盘、尺寸正确、可被证据清单引用 | `03-device-it.log`（IT-ATS603-013 / 020）：1080×2400 的 PNG 落盘 |

失败的四类（docs/25 §5.3）互相区分，**没有笼统的「执行失败」**：

| 分类 | 证据 |
|---|---|
| `session-lost` | `02-unit-tests.log`（UT-ATS603-026） |
| `element-not-found`（附当屏视图层级树） | `02-unit-tests.log`（UT-ATS603-023）、`03-device-it.log`（IT-ATS603-021） |
| `assertion-failed`（点名元素） | `02-unit-tests.log`（UT-ATS603-024）、`03-device-it.log`（IT-ATS603-012） |
| `driver-error`（带设备 stderr） | `02-unit-tests.log`（UT-ATS603-027 / 030 / 031） |

## 计数

| 项 | 数量 | 证据 |
|---|---|---|
| UT（步��语义与边界） | 31 例（UT-ATS603-001..047） | `02-unit-tests.log` |
| UT（适配器与运行生命周期） | 12 例（UT-ATS603-050..065） | `02-unit-tests.log` |
| IT（真实模拟器） | 9 例（IT-ATS603-001..022） | `03-device-it.log` |
| IT（真实 Bridge，HTTP） | 2 例（IT-ATS603-030..031） | `05-bridge-it.log` |
| 整个仓库的测试套件 | 1646 例，1642 通过 / 0 失败 / 4 跳过 | `09-full-test-suite.log` |

## 环境

`01-environment.log`：adb 1.0.41（35.0.2-12147458）、模拟器 `emulator-5554`
（`sdk_gphone64_x86_64`，Android 15 / API 35，屏幕 1080×2400）、
WHPX 加速可用、Node v24.19.0。

**本机没有 iOS 环境，也没有 ADB 连接的 Android 真机**——两者本项未实测，
理由与复现方法见 `docs/25-MOBILE-APP-TESTING.md` §11。

## 复现

```bash
# 1. 起一个模拟器（AVD 名可改）
export ANDROID_HOME="$HOME/AppData/Local/Android/Sdk"
"$ANDROID_HOME/emulator/emulator.exe" -avd Pixel_6_API_35 -no-window -no-audio \
  -no-boot-anim -no-snapshot -gpu swiftshader_indirect -port 5554 -memory 1280 -cores 2

# 2. 构建夹具（SDK 自带工具，无需 Gradle、无需联网）
bash tools/ats603-probes/build-smoke-app.sh

# 3. 跑测试
node --test tests/android-runner.test.mjs tests/android-adapter.test.mjs   # UT
node --test tests/android-runner-it.test.mjs                             # 真实设备
node --test tests/android-bridge-it.test.mjs                              # 真实 Bridge
```

没有设备时，IT **跳过自己并写明原因**——跳过不是通过。

## 注意

- 夹具 App 的签名密钥固定在 `~/.android/ats603-smoke.keystore`
  （可用 `ATS603_KEYSTORE` 覆盖），不在仓库里：它签的是一个测试夹具。
- `06-smoke-app-build.log` 记录的是夹具的构建；APK 本身是**构建产物**，
  不入库（见 `.gitignore` 的 `tools/ats603-probes/build/`）。
