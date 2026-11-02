// Setup changes the selected data source, never the inventory or sync queue.
const Setup = {
  required: false,
  instance: null,
  bound: false,
  busy: false,
  epoch: 0,
  async inspectInstance() {
    if (window.Capacitor?.isNativePlatform?.()) return null;
    try {
      const response = await fetch('/api/instance', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (response.ok) return await response.json();
    } catch (_) { /* A cached PWA can start without any server. */ }
    return null;
  },
  async initialize() {
    this.bind();
    const configured = [DATA_SETTINGS_KEY, 'wms-onboarded', 'wms-mode', 'wms-server-url', 'wms-api-token'].some(key => localStorage.getItem(key));
    if (configured && !DataLayer.settingsError) return true;
    // Older standalone clients may have inventory but no onboarding marker.
    if (!DataLayer.settingsError && DataLayer.mode === 'local' && await LocalDB.count('materials')) {
      DataLayer.setMode('local');
      return true;
    }
    this.required = true;
    await this.open();
    return false;
  },
  async open() {
    this.bind();
    const epoch = ++this.epoch;
    const instance = await this.inspectInstance();
    if (epoch !== this.epoch) return;
    this.instance = instance;
    this.setBusy(false);
    const desktopLocal = this.instance?.mode === 'standalone' && !this.instance.auth_required;
    this.independentMode = desktopLocal && DataLayer.mode !== 'local' ? 'server' : 'local';
    $('setup-local-description').textContent = this.independentMode === 'server'
      ? '使用此电脑上的 SQLite 库存，不需要连接密钥。现有本机库存会保留，服务仅允许本机访问。'
      : '库存保存在此设备的本机离线库（IndexedDB）。不连接服务器，请定期导出完整备份。';
    const pending = await syncPendingCount();
    const count = await LocalDB.count('materials');
    $('setup-existing-note').hidden = this.required && !count && !pending;
    $('setup-existing-note').textContent = `本机离线库：${count} 款物料，${pending} 条待推送。更换连接不会自动推送或清空它们。`;
    $('btn-close-setup').hidden = this.required;
    $('setup-server-url').value = DataLayer.serverUrl || (window.Capacitor?.isNativePlatform?.() ? '' : location.origin);
    $('setup-api-token').value = DataLayer.token;
    this.hideKeys();
    $('setup-shared-panel').hidden = true;
    $('btn-setup-shared').setAttribute('aria-expanded', 'false');
    this.status(DataLayer.settingsError || '', !DataLayer.settingsError);
    openModal('setup-wizard-modal');
    $('btn-setup-local').focus();
  },
  hideKeys() {
    document.querySelectorAll('[data-reveal]').forEach(button => {
      $(button.dataset.reveal).type = 'password';
      button.textContent = '显示';
      button.setAttribute('aria-pressed', 'false');
    });
  },
  cancel() {
    this.epoch++;
    this.setBusy(false);
    this.hideKeys();
  },
  setBusy(value) {
    this.busy = value;
    ['btn-setup-local', 'btn-setup-test', 'btn-setup-connect'].forEach(id => { $(id).disabled = value; });
  },
  status(message, ok = true) {
    $('setup-status').textContent = message;
    $('setup-status').style.color = ok ? 'var(--accent)' : 'var(--danger)';
  },
  bind() {
    if (this.bound) return;
    this.bound = true;
    $('btn-close-setup').onclick = () => closeModal('setup-wizard-modal');
    $('btn-open-setup').onclick = () => this.open().catch(error => showToast(error.message, 'error'));
    document.querySelectorAll('[data-reveal]').forEach(button => {
      button.onclick = () => {
        const input = $(button.dataset.reveal);
        const visible = input.type === 'password';
        input.type = visible ? 'text' : 'password';
        button.textContent = visible ? '隐藏' : '显示';
        button.setAttribute('aria-pressed', String(visible));
      };
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.hideKeys(); });
    $('btn-setup-shared').onclick = () => {
      $('setup-shared-panel').hidden = false;
      $('btn-setup-shared').setAttribute('aria-expanded', 'true');
      $('setup-tab-connect').click();
      $('setup-server-url').focus();
      $('setup-shared-panel').scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    };
    for (const tab of ['connect', 'host']) {
      $('setup-tab-' + tab).onclick = () => {
        for (const name of ['connect', 'host']) {
          $('setup-tab-' + name).classList.toggle('active', tab === name);
          $('setup-tab-' + name).setAttribute('aria-selected', String(tab === name));
          $('setup-' + name + '-pane').hidden = tab !== name;
        }
        this.status('');
      };
    }
    $('btn-setup-local').onclick = () => this.run(async check => {
      const settings = { mode: this.independentMode, url: this.independentMode === 'server' ? '' : DataLayer.serverUrl,
        token: this.independentMode === 'server' ? '' : DataLayer.token };
      if (!this.required && !await confirmDataSwitch('开始独立使用', settings.mode)) return;
      check();
      await commitDataSettings(settings);
    });
    $('btn-setup-test').onclick = () => this.run(async check => {
      const result = await syncTestConnection($('setup-server-url').value, $('setup-api-token').value.trim());
      check();
      this.status(result.msg + '（仅测试，未改变数据源）', result.ok);
    });
    $('btn-setup-connect').onclick = () => this.run(async check => {
      const url = resolveSyncBase($('setup-server-url').value);
      const token = $('setup-api-token').value.trim();
      if (!url) throw new Error('请填写服务器地址，手机上不要使用 localhost');
      this.status('正在验证连接…');
      const result = await syncTestConnection(url, token);
      check();
      if (!result.ok) throw new Error(result.msg);
      if (url !== resolveSyncBase($('setup-server-url').value) || token !== $('setup-api-token').value.trim())
        throw new Error('连接设置已修改，请重新验证');
      if (!this.required && !await confirmDataSwitch('连接并使用服务器', 'server')) return;
      check();
      await commitDataSettings({ mode: 'server', url, token });
    });
  },
  async run(action) {
    if (this.busy) return;
    this.setBusy(true);
    const epoch = this.epoch;
    try { await action(() => { if (epoch !== this.epoch) throw new Error('设置已关闭'); }); }
    catch (error) {
      if (epoch !== this.epoch) return;
      $('setup-shared-panel').hidden = false;
      this.status(error.message, false);
    } finally {
      if (epoch === this.epoch) this.setBusy(false);
    }
  }
};

async function confirmDataSwitch(title, mode) {
  if (dataWritesInFlight || stockRequestBusy || syncInFlight) throw new Error('正在记账或同步，请等待完成再切换');
  const pending = await syncPendingCount();
  const target = mode === 'local' ? '本机离线库' : '选定服务器的库存';
  return showConfirm(title, `接下来读写${target}。不会自动搬移、合并或覆盖库存。${pending ? `本机还有 ${pending} 条待推送操作，将原样保留；请先导出备份并核对所属服务器。` : '原数据保持不变。'}`, '确认切换');
}

async function withDataSettingsLock(callback) {
  const assertIdle = () => {
    if (dataWritesInFlight || stockRequestBusy || syncInFlight) throw new Error('正在记账或同步，请等待完成再切换');
  };
  assertIdle();
  const locks = ['pinbox-data-write', 'pinbox-sync', 'pinbox-online-stock'];
  const acquire = index => {
    if (!navigator.locks || index === locks.length) { assertIdle(); return callback(); }
    return navigator.locks.request(locks[index], { ifAvailable: true }, lock => {
      if (!lock) throw new Error('其他窗口正在记账或同步，请完成后再切换');
      return acquire(index + 1);
    });
  };
  return acquire(0);
}

async function commitDataSettings({ mode = DataLayer.mode, url = DataLayer.serverUrl, token = DataLayer.token }) {
  url = resolveSyncBase(url);
  return withDataSettingsLock(() => {
    DataLayer.setSettings({ mode, url, token });
    window.location.reload();
  });
}
