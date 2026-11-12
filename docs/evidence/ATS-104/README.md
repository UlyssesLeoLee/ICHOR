# ATS-104 证据目录 ｜ Tauri 2 Windows dev build 和 WebView2 适配

> 采集脚本：`bash tools/ats104-probes/collect-evidence.sh`
> 采集环境：Windows 11 (MINGW64_NT-10.0-26300) / Node 24.19.0 / Rust 1.99.1 /
> `stable-x86_64-pc-windows-gnu` + MSYS2 MinGW GCC 16.1.0 / WebView2 Runtime 149.0.4022.98
> 结果：**RESULT: OK**（构建、探针、负控三步都实跑）

## 验收标准与两半

ATS-104 的完成定义是两句，因此证据也分两半：

1. 「Windows 实机完成 `cargo tauri dev`」→ 第 1、2 步。
2. 「关闭窗口后无孤儿窗口」→ 第 2 步的后半段。**这一半最容易做错**：壳原先只在
   `Drop` 里杀 Bridge 子进程，而 Windows 的窗口事件循环以 `std::process::exit` 收尾，
   该路径**不运行任何析构函数**——「Drop 会杀子进程」是对代码的声明，不是对机器的观察。
   探针因此**真关窗**（向主窗口发 `WM_CLOSE`，与用户点 X 同一条路径），
   然后**真观察**进程树里还有没有残留。

## 每一步是什么，怎么复跑

| 文件 | 内容 | 复跑命令 |
|---|---|---|
| `01-cargo-build.log` | 工具链事实（cargo/rustc/tauri 版本、MSVC 工作负载是否在、gnu 链的链接器是哪���个）与 `cargo build`（**含最终链接**）的退出码 | `bash tools/ats104-probes/collect-evidence.sh`（第 1 段） |
| `02-st-022-probe.log` | ST-022 探针的完整输出：`cargo tauri dev` → 窗口出现 → Bridge 应答 → **真关窗** → 孤儿检查 | `node tools/ats104-probes/st-ats104.mjs`（`ATS104_SKIP_BUILD=1` 可跳过构建） |
| `03-negative-control.log` | **负控**：把 `RunEvent::Exit` 里结束 Bridge 的那一段从**产品源码副本**里去掉，重编，跑**同一个探针** | `bash tools/ats104-probes/collect-evidence.sh`（第 3 段） |

## 第 2 步读什么

```
window     : hwnd=35849898 pid=10048 title="AI Test Studio" visible=true
appeared in: 12561ms
  GET /api/health -> 200
  body: {"ok":true,"version":"0.1.0","mode":"local","node":"v24.19.0"}
--- 6. closing the window (WM_CLOSE, the same message the X button sends) ---
  PostMessage(WM_CLOSE) -> sent
--- 7. no orphan window and no orphan process after the close ---
  the shell process is alive: no
  the shell's visible windows: 0
  the shell's tree members still alive: (none)
  the Bridge port is bindable again: yes (waited 3ms)
RESULT: OK -- the dev build opened the window, the Bridge answered, and closing the window left no orphan.
```

## 第 3 步读什么（负控）

负控不是「跑一次没报错」，而是**证明探针有牙齿**：同一个探针，跑在一个**关窗后
Bridge 会存活**的产品副本上，**必须失败**，而且必须**失败在孤儿检查上**。

```
RESULT: FAIL
  - a process of the shell's tree outlived the closed window: 18572(node)
  - the Bridge port was still un-bindable 15000ms after the window was closed
control probe exit = 1
NEGATIVE CONTROL OK: the probe reached the orphan check and rejected
the product whose Bridge outlives the closed window.
```

采集脚本的判定要求负控**必须失败在孤儿检查上**：一个因为「产物缺失」或「窗口没出现」
而失败的负控**没有触到**它要证明的那条检查，因此脚本会把它判成
`NEGATIVE CONTROL INCONCLUSIVE` 而不是 `OK`。

## 本次交付修掉的三个真实缺陷

| 缺陷 | 根因 | 修法 |
|---|---|---|
| 仓库缺 `src-tauri/icons/icon.ico` | `tauri-build` 对任何 windows target 都要生成 Windows Resource 图标，缺它全新 clone 必然构建失败 | 把 `src-tauri/icons/icon.ico` 补进仓库 |
| gnu 链 `cargo build` 链接失败（`export ordinal too large: 91017`） | `crate-type` 含 `cdylib`：gnu 链的 cdylib 把整棵依赖树的符号写进 PE 导出表，导出序号超过 65535 上限 | `crate-type` 去掉 `cdylib`，只留 `staticlib` + `rlib`（本仓库无人消费该 cdylib 产物） |
| 关窗后 Bridge 存活（端口仍被占） | Windows 窗口事件循环以 `std::process::exit` 收尾，不运行析构函数，`Drop` 永不触发 | 在 Tauri 的 `RunEvent::Exit`（窗口事件循环销毁前投递）里显式结束并等待 Bridge 子进程 |

## 未验证项（逐条说明）

- **msvc 链的最终链接**：本机**没有** MSVC「使用 C++ 的桌面开发」工作负载
  （`vswhere -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64` 无输出，
  VS 18 Community 的 `VC/Tools/MSVC` 目录不存在），因此 msvc 链的 `cargo build`
  在本机**无法验证**。本目录的全部结论建立在 **gnu 链**实机结果上。
  `docs/16-BASELINE-ADR.md` §4 B-02 的成因清单在 msvc 链通过之前**仍不视为穷尽**。
- **macOS / Linux 的桌面壳**：未实测（需要对应平台）。
- **ST-021（Next.js 静态构建）**：属 ATS-103，本目录不含该项证据。
- **`cargo check` 通过不作为任何结论的依据**：验收口径是 `cargo build`（含最终链接）。

**PENDING 不等于 PASS**：本目录里每一个 PASS 都对应一条实跑过的命令与它的实际输出。
