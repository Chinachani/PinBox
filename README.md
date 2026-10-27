# PinBox 引脚仓 📦

> **专为电子研发与创客打造的工业级元器件出入库、物理库位管理与 BOM 智能核对系统**  
> *Engineered Craft · High Density · Monospace First*

---

## 🌟 核心亮点

- ⚡ **嘉立创官方对账单智能导入**：一键上传立创商城导出的 Excel (`.xlsx` / `.xls`) 或 CSV，自动识别物料编号、封装、采购单价与实购数量，并**自动推导出元器件的真实电路实验用途**。
- 📷 **极速条码识别与精准出入库**：针对立创物料包装袋上的二维码优化（支持 `pc:`、`pm:`、`qty:` 键值格式与纯标签），支持连续扫码，扫完自动带出真实在包数量并一键核验入库。
- 📍 **物理收纳盒图谱与一键归位**：告别翻箱倒柜！为每个芯片、电阻分配抽屉格子（如 `A-01-02` 或 `阻容盒1号`），支持批量物料一键归位，支持生成带二维码的实体收纳盒标签直接打印。
- 📋 **BOM 智能比对与成本估算**：粘贴电路设计的 BOM 文本或上传表格，独创五层语义对碰链（支持同规格跨品牌匹配，如根据三星/厚声料号自动反解出阻值与容值），一键算出缺料清单与采购预算。
- 🌐 **双运行架构**：
  - **局域网服务器/Docker 模式**：轻量常驻部署（内存仅 30+ MB），手机端浏览器扫码或添加快捷方式至桌面；
  - **跨平台桌面与原生端**：支持打包为独立的 Windows `.exe`、Linux `.deb` 及 Android `.apk` 客户端。

---

## 🚀 局域网 Docker 快速部署

在服务器或带有 Docker 的宿主机上：

```bash
# 1. 克隆本仓库
git clone https://github.com/Chinachani/PinBox.git
cd PinBox

# 2. 一键启动服务
docker compose up -d --build

# 3. 访问系统
# HTTP 免证书访问: http://<你的IP>:8088
# HTTPS 扫码专用口: https://<你的IP>:8089
```

---

## 🛠️ 本地开发与直接运行

```bash
# 1. 安装 Python 核心依赖
pip install -r backend/requirements.txt

# 2. 启动全栈服务
python backend/main.py

# 打开浏览器访问 http://localhost:8088 即可
```

---

## 📦 跨平台打包与发布 (CI/CD)

本项目配置了完整的 GitHub Actions 工作流：
- **Windows 客户端**：自动打包为独立的绿色免安装版 / 单文件安装程序 (`.exe`)；
- **Linux 客户端**：自动打包为通用 Debian/Ubuntu 安装包 (`.deb`) 与便携 `.AppImage`；
- **Android 原生客户端**：打包为全离线独立安装包 (`.apk`)，调用原生相机，摆脱浏览器证书限制。

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 开源协议。
