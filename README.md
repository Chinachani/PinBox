# PinBox 引脚仓 📦

> **专为电子研发与创客打造的元器件掌上仓库管理系统**
> 扫码出入库 · 物理库位 · BOM 智能核对 · 离线可用
> *Engineered Craft · High Density · Offline First*

[![Release](https://img.shields.io/github/v/release/Chinachani/PinBox?include_prereleases&logo=github)](https://github.com/Chinachani/PinBox/releases)
[![CI](https://github.com/Chinachani/PinBox/actions/workflows/release.yml/badge.svg)](https://github.com/Chinachani/PinBox/actions/workflows/release.yml)
[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-blue)](https://github.com/Chinachani/PinBox/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## ✨ 它解决什么问题

电子爱好者囤料多了之后的三大痛点，PinBox 一次管完：

| 痛点 | PinBox 方案 |
|---|---|
| **不知道料在哪** | 收纳盒库位体系：物料归位到盒、扫码直达清单、可打印带盒内清单的实体标签 |
| **不知道还剩多少** | 手机扫立创包装袋二维码即见库存，连续扫码批量出入库，低库存自动预警 |
| **不知道 BOM 缺什么** | 粘贴 BOM 文本/上传表格，五层智能匹配库存（支持**同规格跨品牌**），一键算缺料与成本 |

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
- 输出：逐行命中状态（✓够用/⚠缺N/✗未找到）、候选可人工改选、**BOM 总成本 + 缺料补齐成本**、导出 CSV、一键复制缺料/补货清单

### 🌐 双模式架构（Offline First）
- **服务器在线模式**：FastAPI + SQLite 轻量常驻（内存 30+ MB），Docker 一键部署，局域网多端共享
- **本地离线模式**：PWA 装到手机桌面后完全离线可用，全部数据存本机 IndexedDB，**BOM 引擎、条码解析、二维码生成全部前端本地运行**
- **双向同步**：离线操作记录队列，回网一键推送服务器；或拉取服务器快照覆盖本机。网络不可达自动降级离线

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
# HTTPS 摄像头扫码:  https://<你的IP>:8089 （自签证书）
```

> 摄像头扫码需要安全上下文，手机请访问 HTTPS 端口（首次需信任自签证书）。

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
是系统深度链接（`http://<IP>:8088/?loc=库名`）。手机相机扫出后点开即直达该收纳盒的实时物料清单。

**Q: 离线模式和服务器模式数据会冲突吗？**
同一时间只用一个模式即可。离线产生的变更会进入待推送队列，回网后「推送」按时间序重放到服务器；「拉取」会用服务器数据覆盖本机（有确认弹窗）。

**Q: 如何备份数据？**
三层保障：管理页「下载全量备份」（JSON）；服务器每日 03:00 自动备份到 `data/backups/`（保留 30 份）；直接拷贝 `data/inventory.db`。

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 开源协议。
