# PinBox 引脚仓 📦

> **专为电子研发与创客打造的元器件掌上仓库管理系统**
> 扫码出入库 · 物理库位 · BOM 智能核对 · 离线可用
> *Engineered Craft · High Density · Offline First*

[![Release](https://img.shields.io/github/v/release/Chinachani/PinBox?include_prereleases&logo=github)](https://github.com/Chinachani/PinBox/releases)
[![CI](https://github.com/Chinachani/PinBox/actions/workflows/release.yml/badge.svg)](https://github.com/Chinachani/PinBox/actions/workflows/release.yml)
[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-blue)](https://github.com/Chinachani/PinBox/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

1.0.21 已修复库存同步、备份恢复、扫码及 BOM 等问题，详见 [审查记录与升级说明](docs/AUDIT-2026-10-30.md)。

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
- **本地离线模式**：PWA 装到手机桌面后完全离线可用，全部数据存本机 IndexedDB，**BOM 引擎、条码解析、二维码生成全部前端本地运行**
- **双向同步**：离线操作记录队列，回网一键推送服务器（幂等重试，冲突保留）；或在无待推送操作时拉取服务器快照覆盖本机。网络不可达时可手动切换本地模式，失败请求不会提示成功

### 🛠 数据与运维
- 立创对账单 Excel/CSV 智能导入，自动补全**物料用途描述**（内置常见元器件用途知识库）
- 资产看板：分类资产价值 Top 12、近 7 天出入库趋势、项目用料统计（出库可关联项目名）
- 每日 03:00 自动备份数据库（保留 30 份）+ 全量备份/恢复 + CSV/JSON 导出
- 明暗双主题（跟随系统 + 手动切换）、全键盘快捷键（`/` 聚焦搜索）

---

## 🚀 快速开始

### 方式一：Docker 部署（推荐）

```bash
git clone https://github.com/Chinachani/PinBox.git
cd PinBox
docker compose up -d --build

# HTTP 免证书访问:   http://<你的IP>:8088
# HTTPS 摄像头扫码:  https://<你的IP>:8089 （提供 certs/cert.pem 和 certs/key.pem 后启用）
```

> 摄像头扫码需要安全上下文。HTTPS 端口在提供证书后启用；自签证书需先由设备信任。没有证书时仍可 HTTP 访问并拍照识别。

### 方式二：直接运行

```bash
pip install -r backend/requirements.txt
python backend/main.py
# 打开 http://localhost:8088
```

### 方式三：下载成品客户端

从 [Releases](https://github.com/Chinachani/PinBox/releases) 下载：

| 包 | 说明 |
|---|---|
| `PinBox-v*.apk` | Android 原生客户端（Capacitor），装上即是独立 App |
| `PinBox-Windows-x64.zip` | Windows 绿色免安装版 |
| `pinbox_*_amd64.deb` | Debian / Ubuntu 安装包 |

> Android APK 与离线 PWA 共享同一套前端，均支持离线模式与服务器同步。

---

## 📱 手机使用建议（PWA）

1. 手机浏览器访问 HTTPS 端口 `https://<IP>:8089`
2. Android：浏览器菜单 →「安装应用」；iOS：Safari 分享 →「添加到主屏幕」
3. 在 **管理与看板 → 数据中心** 可切换：
   - `服务器在线` —— 局域网内多端共享实时数据
   - `本地离线` —— 任何地方可用，回网后「推送离线变更 / 从服务器拉取」

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
│   ├── bom.py               # BOM 解析与五层匹配引擎
│   ├── parser.py            # 立创条码与对账单解析
│   ├── use_case_infer.py    # 物料用途自动推导知识库
│   └── database.py          # SQLite 结构与幂等迁移
├── frontend/
│   ├── js/app.js            # 全部界面逻辑（单文件应用）
│   ├── js/local-api.js      # 离线模式本地 API（含 BOM JS 引擎）
│   ├── js/api.js            # 双模式 DataLayer + 同步
│   ├── js/local-db.js       # IndexedDB 封装
│   ├── index.html / css/    # 界面与工业风主题
│   └── icons/               # PWA 图标（PNG/SVG）
├── android/                 # Capacitor Android 原生工程
├── ci-workflows/            # CI 配置副本
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

**Q: 如何备份数据？**
三层保障：管理页「下载全量备份」（JSON）；服务器每日 03:00 自动备份到 `data/backups/`（保留 30 份）；直接拷贝 `data/inventory.db`。

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 开源协议。

## 开发、部署与签名配置

```bash
pip install -r backend/requirements.txt pytest httpx
npm ci
python -m pytest tests/test_inventory.py -q
npm test
npx playwright install chromium
CI=true npm run test:e2e
```

可选环境变量：

| 变量 | 用途 |
| --- | --- |
| `PINBOX_DATA_DIR` | 数据库存放目录；源码运行默认 `data/`，打包程序默认用户数据目录 |
| `PINBOX_API_TOKEN` | 启用 API Bearer 令牌，在客户端数据中心填写相同令牌 |
| `PINBOX_ALLOWED_ORIGINS` | 额外允许的网页来源，以逗号分隔，例如 `https://pinbox.example.com` |
| `PINBOX_CERT_FILE` / `PINBOX_KEY_FILE` | HTTPS 证书与私钥路径 |
| `PINBOX_HOST` | HTTP 监听地址；打包程序默认 `127.0.0.1` |

Android release 构建需要四项 GitHub Secrets：`PINBOX_SIGNING_KEYSTORE`（原 PKCS12 文件的 Base64）、`PINBOX_STORE_PASSWORD`、`PINBOX_KEY_ALIAS`、`PINBOX_KEY_PASSWORD`。本机构建可通过同名环境变量（签名文件使用 `PINBOX_KEYSTORE` 路径）或忽略的 `android/signing.properties` 配置。不要将签名文件或口令重新提交；原签名的历史暴露情况见审查记录。

`init_data.py` 会读取最新库存源文件；现有数据库非空时默认拒绝覆盖。显式 `python init_data.py --reset` 才会备份后重建，日常添加订单请用程序的导入功能。
