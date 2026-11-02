# PinBox 引脚仓 📦

> **专为电子研发与创客打造的元器件掌上仓库管理系统**
> 扫码出入库 · 物理库位 · BOM 智能核对 · 离线可用
> *Engineered Craft · High Density · Offline First*

[![Release](https://img.shields.io/github/v/release/Chinachani/PinBox?include_prereleases&logo=github)](https://github.com/Chinachani/PinBox/releases)
[![CI](https://github.com/Chinachani/PinBox/actions/workflows/release.yml/badge.svg)](https://github.com/Chinachani/PinBox/actions/workflows/release.yml)
[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-blue)](https://github.com/Chinachani/PinBox/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

**当前版本 1.0.25**：补强连接设置保存，浏览器存储不足时完整保留原地址、密钥与模式，避免半保存造成连接错配；详见 [1.0.25 修订说明](docs/CONNECTION-1.0.25.md)。

**1.0.24 新增首次使用引导与自动安全部署**：独立使用无需配置连接密钥；共享仓库首次部署自动生成密钥，升级保持不变。改进分类列表、数据中心与移动端界面，详见 [1.0.24 更新说明](docs/SETUP-1.0.24.md)。1.0.22 / 1.0.23 的库存、同步、导入和 BOM 修复详见 [修复与升级说明](docs/FIXES-2026-11-03.md)。升级前分别备份服务器与客户端待推送数据，勿卸载 App 或清空浏览器数据。

## ✨ 它解决什么问题

电子爱好者囤料多了之后的三大痛点，PinBox 一次管完：

| 痛点 | PinBox 方案 |
|---|---|
| **不知道料在哪** | 收纳盒库位体系：物料归位到盒、扫码直达清单、可打印带盒内清单的实体标签 |
| **不知道还剩多少** | 手机扫立创包装袋二维码即见库存，连续扫码批量出入库，低库存自动预警 |
| **不知道 BOM 缺什么** | 粘贴 BOM 文本/上传表格，五层智能匹配库存（相似规格可人工核对选择），一键算缺料与成本 |

## 🌟 核心功能

### 📷 扫码出入库
- **针对立创包装袋优化**：识别 `pc:C编号, pm:型号, qty:数量` 二维码，扫完自动带出标签数量
- **连续扫码模式**：连续入库/连续出库一键切换，每扫一袋自动按标签数量记账，同袋防重复，实时累计
- **三重识别保障**：摄像头实时扫 → 拍照前端识别 → 服务端 zxing-cpp 多尺度增强引擎兜底
- **扫码枪即插即用**：USB / 蓝牙扫码枪全局监听，全程无需碰鼠标

### 📍 物理库位管理
- 收纳盒/抽屉格位任意命名（`A-01-02`、`阻容盒3号`），批量归位一键完成
- **智能实体标签**：二维码内嵌深度链接（手机相机扫出即开），标签上直接印**盒内物料清单 + 数量 + 打印时间 + 最近变动日期**，30 天未动的料自动标记积压
- 库位重命名自动同步全部物料

### 📋 BOM 一键核对
- 支持**粘贴文本**（`型号 数量`，空格/Tab/逗号均可）与上传表格（`.xlsx/.xls/.csv`）
- **五层匹配链**：C编号直击 → 型号精确 → 归一化包含 → 短料号直击 → **规格解码匹配**（`0603WAJ0103T5E` 自动反解出 10kΩ+0603，跨品牌命中同规格库存电阻）
- 输出：逐行命中状态（✓够用/⚠缺N/✗未找到）、相似规格须人工确认、重复用料共享库存、**BOM 总成本 + 缺料补齐成本**、导出 CSV、一键复制缺料/补货清单

### 🌐 双模式架构（Offline First）
- **服务器在线模式**：FastAPI + SQLite 轻量常驻（内存 30+ MB），Docker 一键部署，局域网多端共享
- **本地离线模式**：原生 App 或在受信任 HTTPS 下已缓存的 PWA 可离线启动，本地库存存本机 IndexedDB，**BOM 引擎、条码解析、二维码生成全部前端本地运行**；普通局域网 HTTP 快捷方式不具备 PWA 离线启动能力
- **双向同步**：离线操作记录队列，回网一键推送服务器（幂等重试，冲突保留）；或在无待推送操作时拉取服务器快照覆盖本机。网络不可达时可手动切换本地模式，失败请求不会提示成功

### 🛠 数据与运维
- 立创对账单 Excel/CSV 智能导入，自动补全**物料用途描述**（内置常见元器件用途知识库）
- 资产看板：分类资产价值 Top 12、近 7 天出入库趋势、项目用料统计（出库可关联项目名）
- 每日 03:00 自动备份数据库（保留 30 份）+ 全量备份/恢复 + CSV/JSON 导出
- 明暗双主题（跟随系统 + 手动切换）、全键盘快捷键（`/` 聚焦搜索）

---

## 🚀 快速开始

### 首次打开：选择使用方式

| 使用场景 | 建议方式 | 连接密钥 |
| --- | --- | --- |
| 只在当前手机或浏览器记账 | 选择“独立使用”，使用本机库存并定期导出备份 | 不需要服务器或密钥 |
| 只在一台电脑使用 | Windows / Linux 成品程序的本机服务，默认只允许本机访问 | 默认不需要 |
| 连接管理员已经部署的库存 | 选择“多设备使用 → 连接已有仓库”，输入管理员提供的地址与连接密钥 | 使用管理员提供的同一个密钥 |
| 手机、电脑共享库存，或部署到 NAS / 小主机 | 按下方步骤创建共享仓库，再连接各设备 | 首次自动生成，后续部署保留 |

首次使用引导提供“独立使用 / 多设备使用”两个入口；多设备入口再区分“连接已有仓库 / 部署新仓库”。已有配置和数据不会因为升级被清空。电脑成品程序独立使用沿用本机 SQLite 库存，不会悄悄换成空的浏览器库；已明确选择本地离线的客户端仍保留其 IndexedDB 库存。创建共享仓库需要在实际服务器上部署，**网页不能匿名领取管理员密钥，也不能把服务端改成无认证模式**。本版不提供扫码配对或在线注册账号。

> 本机离线库与服务器库存是两份独立数据。选择模式不会自动搬运、合并或覆盖库存。已有本机数据需要迁移时，先导出完整备份，再使用数据中心的推送 / 拉取流程；有待推送操作时不能直接拉取覆盖。手机 APK 可独立离线启动；浏览器离线启动需要受信任 HTTPS / localhost 安全上下文并已成功缓存，普通局域网 HTTP 快捷方式不等同于离线 App。

### 方式一：Docker 自动部署（多设备推荐）

服务器需要 Docker Engine、Docker Compose 插件及 POSIX Shell；**宿主机不需要安装 Python**。在自己的服务器上运行：

```bash
git clone https://github.com/Chinachani/PinBox.git
cd PinBox
sh install.sh
```

安装器会构建镜像、生成或保留连接密钥、保存项目根目录的私有 `.env`、启动容器并检查接口就绪。Docker 部署始终采用共享模式并启用认证。

- 首次安装且使用交互终端时，安装器直接显示新生成的连接密钥。
- CI / 管道等非交互环境只输出配置文件位置，不把密钥写入日志。已有部署升级也不反复打印密钥。
- 默认地址为 `http://<服务器IP>:8088`。如果有确定的域名 / 地址，可使用 `PINBOX_PUBLIC_URL=https://库存域名 sh install.sh` 显示该地址；此参数只用于提示，不配置 DNS、证书或反向代理。
- HTTPS 8089 需要提供 `certs/cert.pem` 和 `certs/key.pem`；客户端必须信任证书。HTTP 能传输数据，但**不会加密密钥与库存**，推荐受信任 HTTPS，勿直接把未妥善保护的端口暴露到公网。

安装完成后，在客户端首次使用引导中选择连接已有仓库，填写地址和连接密钥。已有客户端可在“管理与看板 → 桌面与系统 → 数据中心”修改：先测试，再应用连接设置；操作共享库存时选择“服务器在线”。

常用管理命令（在项目目录运行）：

```bash
# 查看状态，不显示密钥
sh install.sh status

# 仅在私有终端显式查看密钥，勿录屏或转发输出
sh install.sh token show

# 泄露时重置，确认后自动重新创建服务；所有客户端需要重新连接
sh install.sh token reset --yes

# 升级代码后重建，保留原密钥与库存
# 有本地源码修改时，请先妥善处理，不要强制覆盖
git pull --ff-only
sh install.sh update
```

如果当前 shell 导出了 `PINBOX_API_TOKEN`，重置前先取消该 shell 覆盖值，否则 Compose 会优先使用旧环境变量而不是更新后的 `.env`；脚本会拒绝这种重置，避免显示“已更新”但服务仍使用旧密钥。

仍可直接使用 `docker compose up -d --build`：共享服务会将自动生成的密钥保存到持久化 `data/access.json`，**不会打印到容器日志**。此时可执行 `docker compose exec lcsc-stock-mobile python backend/manage.py token show` 查看。后续采用 `install.sh` 时，会保留持久化目录里已有的共享密钥并写入 `.env`，不会为接管管理而更换它。为统一配置与后续管理，推荐从首次部署起使用 `install.sh`。密钥为空不再代表关闭共享服务认证。

### 方式二：下载成品程序

从 [Releases](https://github.com/Chinachani/PinBox/releases) 下载：

| 包 | 说明 |
|---|---|
| `PinBox-v*.apk` | Android 原生客户端，首次引导选择独立使用或连接共享仓库 |
| `PinBox-Windows-x64.zip` | Windows 绿色版，含 `PinBox.exe` 与命令行管理工具 `PinBoxAdmin.exe` |
| `pinbox_*_amd64.deb` | Debian / Ubuntu 安装包，命令为 `pinbox` |

Windows / Linux 成品程序首次没有配置时默认独立模式，HTTP 与 HTTPS 都只监听回环地址。打开 `http://127.0.0.1:8088` 使用本机服务。以后要作为共享服务器，在**同一操作系统用户**下配置并重新启动程序：

```bash
# Linux
pinbox setup --mode shared
pinbox status
pinbox token show
# 随后重新启动 pinbox，并在其他设备配置地址与密钥

# 改回独立模式，重新启动后仅本机可访问
pinbox setup --mode standalone
```

Windows 在 PowerShell 中进入解压目录运行：

```powershell
.\PinBoxAdmin.exe setup --mode shared
.\PinBoxAdmin.exe status
.\PinBoxAdmin.exe token show
# 关闭原程序后重新打开 PinBox.exe
```

`setup` 在交互终端首次生成密钥时显示结果；非交互默认只显示状态。`token show` 是显式查看，`token reset --yes` 是显式重置。GUI 版 `PinBox.exe` 不承担命令行输出，Windows 管理请使用 `PinBoxAdmin.exe`。

### 方式三：从源码运行

在项目根目录建立 Python 环境并安装依赖。选择模式是明确的配置步骤，不需要自己写随机密钥：

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install --require-hashes -r backend/requirements.lock

# 独立使用：HTTP 和 HTTPS 均只允许本机访问
python backend/main.py setup --mode standalone
python backend/main.py
# 打开 http://127.0.0.1:8088
```

多设备服务改用 `python backend/main.py setup --mode shared`，然后重新启动服务。**源码首次不执行 setup 时默认共享模式并自动启用密钥**，不会留下无认证的局域网库存接口。源代码管理命令也可直接使用 `python backend/manage.py status` / `token show` / `token reset --yes`，不会初始化或修改库存数据库。

### 配置保存在什么地方？

| 部署方式 | 配置位置 |
| --- | --- |
| 推荐 Docker 安装器 | 项目根目录 `.env`，由 Compose 传入服务；模式元信息另存 `data/access.json` |
| 直接 Compose、源码运行 | `data/access.json`；设置 `PINBOX_DATA_DIR` 后改用该目录 |
| Windows 成品程序 | `%LOCALAPPDATA%\PinBox\access.json` |
| Linux 成品程序 | `$XDG_DATA_HOME/PinBox/access.json`；未配置时为 `~/.local/share/PinBox/access.json` |

配置文件采用原子写入，POSIX 权限为 `600`。请使用专门的服务账号和受限目录，Windows 上也应限制文件 ACL。保留这些私有文件，勿强制提交 Git、放入截图或公开日志。

**优先级：环境变量 > 已保存配置 > 默认值。** 非空 `PINBOX_API_TOKEN` 始终作为实际密钥，即使设置为独立模式也不会偷偷移除。`PINBOX_DEPLOYMENT_MODE` 显式控制 `standalone` / `shared`。环境变量控制的服务须修改环境并重启，不能仅更改配置文件来覆盖它。

直接运行程序不会自动读取项目 `.env`；这是 Compose 的职责。需要单独管理 Compose 配置时可运行：

```bash
python backend/manage.py setup --mode shared --env-file .env --json
python backend/manage.py token reset --yes --env-file .env
docker compose up -d --force-recreate
```

`--env-file` 管理指定私有文件中的连接配置，保留其他配置；显式重置时还会同步更新已有的 `access.json` 备用密钥，防止旧密钥再次生效。不加它则管理当前数据目录的 `access.json`。`--json` 始终只输出非敏感元信息，即使和查看命令一起使用也不输出密钥。`--show-token` 可显式要求 setup 显示密钥，但不应在共享 CI 日志中使用。仅执行 `docker compose restart` 不会加载更新后的 Compose 环境变量。

---

## 📱 手机使用建议（PWA）

1. 手机浏览器访问 HTTPS 端口 `https://<IP>:8089`
2. Android：浏览器菜单 →「安装应用」；iOS：Safari 分享 →「添加到主屏幕」
3. 在 **管理与看板 → 桌面与系统 → 数据中心** 配置服务器地址和令牌，可切换：
   - `服务器在线` —— 局域网内多端共享实时数据
   - `本地离线` —— 成功缓存后可离线使用，回网后「推送离线变更 / 从服务器拉取」

---

## 🧱 技术栈

```
后端  Python FastAPI + SQLite（零外部依赖服务）
前端  原生 HTML/CSS/JS，无框架，PWA（Service Worker + IndexedDB）
扫码  html5-qrcode（前端）+ zxing-cpp（服务端增强）
打包  Docker / PyInstaller / Capacitor Android / GitHub Actions CI
```

**项目结构**

```
PinBox/
├── backend/
│   ├── main.py              # FastAPI 全部 API（物料/库位/流水/BOM/备份）
│   ├── access.py / manage.py # 私有连接配置与命令行管理（不修改库存）
│   ├── bom.py               # BOM 解析与五层匹配引擎
│   ├── parser.py            # 立创条码与对账单解析
│   ├── use_case_infer.py    # 物料用途自动推导知识库
│   └── database.py          # SQLite 结构与幂等迁移
├── frontend/
│   ├── js/app.js            # 库存界面与操作流程
│   ├── js/setup.js          # 首次使用引导与安全切换数据源
│   ├── js/local-api.js      # 离线模式本地 API（含 BOM JS 引擎）
│   ├── js/api.js            # 双模式 DataLayer + 同步
│   ├── js/local-db.js       # IndexedDB 封装
│   ├── index.html / css/    # 界面与工业风主题
│   └── icons/               # PWA 图标（PNG/SVG）
├── android/                 # Capacitor Android 原生工程
├── ci-workflows/            # CI 配置副本
├── install.sh               # 通用 Docker 安装 / 升级 / 连接密钥管理
└── docker-compose.yml
```

---

## ❓ 常见问题

**Q: 手机摄像头打不开？**
摄像头要求安全上下文：使用 HTTPS 端口（:8089）访问，或使用 Android 原生 APK（无此限制）。HTTP 下仍可用「拍照/选图识别」。

**Q: 扫码识别慢或不准？**
确保访问的是最新版本（强刷一次页面）。系统已针对立创包装二维码限定 QR_CODE 格式；模糊反光包装可用「拍照识别」走服务端增强引擎。

**Q: 库位标签上二维码扫出来是什么？**
配置服务器地址时是系统深度链接（`http://<IP>:8088/?loc=库名`），原生离线端未配置服务器时使用 App 可识别的 `LOC:库名`。手机相机扫出后点开即直达该收纳盒的实时物料清单。

**Q: 离线模式和服务器模式数据会冲突吗？**
离线变更进入事务队列，推送时按序执行并用操作号防止重复入账。服务器字段变化、建档撞号、库存不足等冲突会保留队列并停止推送。尚有待推送操作时禁止拉取覆盖，处理方式见升级说明。

**Q: 连接密钥就是以前的 API 令牌吗？在哪里查看？**
是，同一项服务器共享密钥，只是界面采用更易懂的名称。Docker 安装器使用 `sh install.sh token show`；Linux 使用 `pinbox token show`；Windows 使用 `PinBoxAdmin.exe token show`；源码使用 `python backend/manage.py token show`。查看必须在管理员私有终端执行；未认证 API 只公布使用模式、是否需要密钥和版本，不提供密钥。仓库中的 `scripts/deploy-219.py` 是特定主机维护脚本，其他用户请使用通用 `install.sh`。

**Q: 密钥忘记或泄露了怎么办？**
忘记先在服务器使用 `token show` 找回。泄露后使用对应工具的 `token reset --yes`；Docker 安装器会重新创建服务，其他方式请重启服务并在各客户端更新密钥。若密钥来自环境变量，CLI 不会假装覆盖它：须指定实际 Compose `--env-file` 或修改服务管理器的环境配置；当前 shell 的同名变量也不能继续覆盖新值。更换密钥不清空库存、不恢复备份、不移除客户端本地队列。升级不会自动重置密钥。通过 `--env-file` 明确重置时，也会同步更新 `access.json` 中已经存在的备用密钥，防止 `.env` 丢失后恢复旧密钥。两份配置不能跨文件原子提交：先更新私有备用配置，再更新 `.env`；任何写入失败都会报告失败，安装器不会继续重新创建服务。请修复错误后重试，环境变量中的旧密钥在服务重新创建前仍然有效。

**Q: 独立模式会不会不小心开放给局域网？**
不会按共享模式开放：HTTP 和 HTTPS 均绑定回环地址，并在 API / WebSocket 上检查客户端 IP 与 Host，阻止外部访问与 DNS 重绑定。独立模式下显式设置 `PINBOX_HOST=0.0.0.0` 会报错；需要网络访问应切换共享模式并保留认证。客户端选择本地离线不等于修改服务器部署模式，两者不要混淆。

**Q: 每位用户都有自己的令牌或不同权限吗？**
目前没有账号、按用户授权或自动过期机制；这是服务器共享的访问密钥，持有者可以调用库存读写、备份、恢复和清空等 API。仅向可信设备或人员提供。如果需要员工分权、独立撤销某台设备或访问审计，需要另行实现，不能把共享令牌当成完整的多用户权限系统。

**Q: 如何备份数据？**
三层保障：管理页「下载全量备份」（JSON）；服务器每日 03:00 自动备份到 `data/backups/`（保留 30 份）；停止服务后复制整个 `data/` 目录。不要在服务写入期间仅拷贝单个数据库文件。升级前还应分别导出各客户端的本地完整备份，尤其是尚未推送的离线队列；不要为升级卸载 App 或清空浏览器数据。

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 开源协议。

## 开发、部署与签名配置

```bash
pip install --require-hashes -r backend/requirements.lock pytest httpx
npm ci
python -m pytest tests -q
npm test
npx playwright install chromium
CI=true npm run test:e2e
# 需要 Docker + Compose，使用临时目录和合成库存
python scripts/smoke-install.py
```

可选环境变量：

| 变量 | 用途 |
| --- | --- |
| `PINBOX_DATA_DIR` | 数据库存放目录；源码运行默认 `data/`，打包程序默认用户数据目录 |
| `PINBOX_API_TOKEN` | 非空时覆盖保存的连接密钥；共享模式缺省或为空时自动生成私有密钥，绝不因此关闭认证 |
| `PINBOX_DEPLOYMENT_MODE` | `standalone` / `shared`；覆盖保存模式。共享需要密钥，独立仅本机访问 |
| `PINBOX_ALLOWED_ORIGINS` | 额外允许的网页来源，以逗号分隔，例如 `https://pinbox.example.com` |
| `PINBOX_CERT_FILE` / `PINBOX_KEY_FILE` | HTTPS 证书与私钥路径 |
| `PINBOX_HOST` | 同时控制 HTTP 与 HTTPS 监听；独立默认 `127.0.0.1` 且不接受外部地址，共享默认 `0.0.0.0` |
| `PINBOX_PUBLIC_URL` | 安装脚本显示给管理员的访问地址；仅提示用途，不配置证书、代理或监听 |

Android release 构建需要四项 GitHub Secrets：`PINBOX_SIGNING_KEYSTORE`（原 PKCS12 文件的 Base64）、`PINBOX_STORE_PASSWORD`、`PINBOX_KEY_ALIAS`、`PINBOX_KEY_PASSWORD`。本机构建可通过同名环境变量（签名文件使用 `PINBOX_KEYSTORE` 路径）或忽略的 `android/signing.properties` 配置。不要将签名文件或口令重新提交；原签名的历史暴露情况见审查记录。

`init_data.py` 会读取最新库存源文件；现有数据库非空时默认拒绝覆盖。显式 `python init_data.py --reset` 才会备份后重建，日常添加订单请用程序的导入功能。
