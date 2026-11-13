/*---------------------------------------------------------------------------------------------
 *  MyCode 开发工具（VS Code 侧边栏扩展）
 *  一个侧边栏面板承载：项目 / 服务器运维 / 会员后台。
 *  所有操作点按钮完成，命令由扩展注入集成终端，无需命令面板、无需手敲命令。
 *--------------------------------------------------------------------------------------------*/

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const scanner = require('./scanner');

let panelProvider = null;
let configUri = null;
let extContext = null;

/* ---------------------------------- 配置 ---------------------------------- */

function defaultConfigPath() {
	const custom = vscode.workspace.getConfiguration('mycodeTools').get('configPath');
	if (custom && typeof custom === 'string' && fs.existsSync(custom)) return custom;
	return configUri.fsPath;
}

function ensureUserConfig() {
	try {
		const dir = extContext.globalStorageUri.fsPath;
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		configUri = vscode.Uri.joinPath(extContext.globalStorageUri, 'mycode_config.json');
		let needScan = !fs.existsSync(configUri.fsPath);
		if (!needScan) {
			// 旧版本写死模板（无 scanned_at）自动升级为真实探测结果；
			// 用户手工编辑过的配置只要带 scanned_at 就不会被覆盖。
			try {
				const old = JSON.parse(fs.readFileSync(configUri.fsPath, 'utf8'));
				needScan = !old.scanned_at || old.scanner_version !== scanner.SCANNER_VERSION;
			} catch { needScan = true; }
		}
		if (needScan) rescan(false);
	} catch (err) {
		console.error('[mycode-tools] ensureUserConfig:', err);
	}
}

function projectsRoot() {
	try {
		const data = JSON.parse(fs.readFileSync(defaultConfigPath(), 'utf8'));
		if (data.projects_root) return data.projects_root;
	} catch { /* noop */ }
	const custom = vscode.workspace.getConfiguration('mycodeTools').get('projectsRoot');
	if (custom && typeof custom === 'string') return custom;
	return path.join(require('os').homedir(), 'Projects');
}

/** 真实扫描项目根目录下所有项目，重建配置并刷新面板。 */
function rescan(notify = true) {
	try {
		const data = scanner.scan(projectsRoot());
		fs.writeFileSync(defaultConfigPath(), JSON.stringify(data, null, 2), 'utf8');
		if (panelProvider) panelProvider.refresh();
		const n = data.projects.length;
		const cmds = data.projects.reduce((a, p) => a + (p.functions || []).filter(f => f.type === 'run' || f.type === 'url').length, 0);
		if (notify) status('探测完成：' + n + ' 个项目、' + cmds + ' 条可用命令，依据已显示在按钮下方');
		startWatcher(); // 根目录可能变了，重新挂监听
		return data;
	} catch (err) {
		const msg = '探测失败：' + (err && err.message || err);
		if (notify) status(msg);
		console.error('[mycode-tools] rescan:', err);
		return null;
	}
}

function loadConfig() {
	try {
		const raw = fs.readFileSync(defaultConfigPath(), 'utf8');
		const data = JSON.parse(raw);
		return {
			projects_root: data.projects_root || '',
			scanned_at: data.scanned_at || '',
			toolchain: data.toolchain || {},
			projects: Array.isArray(data.projects) ? data.projects : [],
			servers: Array.isArray(data.servers) ? data.servers : [],
			admin_sites: Array.isArray(data.admin_sites) ? data.admin_sites : []
		};
	} catch (err) {
		return { projects: [], servers: [], admin_sites: [], error: String(err && err.message || err) };
	}
}

function normPath(p) {
	return String(p || '').replace(/\\/g, '/');
}

/* --------------------------------- 终端 ---------------------------------- */

const terminals = new Map();      // key -> vscode.Terminal
const interactive = new Set();   // 已建立交互式 SSH 会话的 server key

function terminalFor(key, name, cwd) {
	let t = terminals.get(key);
	if (!t) {
		const opts = { name: name };
		if (cwd) opts.cwd = cwd;
		// 生成的命令用 cmd 语法（call / && / 引号包裹的 .bat），
		// 显式指定 cmd.exe，避免用户默认终端是 PowerShell 时命令失效。
		if (process.platform === 'win32') opts.shellPath = 'C:\\Windows\\System32\\cmd.exe';
		t = vscode.window.createTerminal(opts);
		terminals.set(key, t);
	}
	t.show(true); // 保留焦点，不把输入焦点从侧边栏抢走
	return t;
}

function disposeTerminal(key) {
	const t = terminals.get(key);
	if (t) { try { t.dispose(); } catch (_) { /* noop */ } }
	terminals.delete(key);
	interactive.delete(key);
}

function runLocal(project, fn) {
	const cwd = normPath(project.path);
	const t = terminalFor('project:' + project.id, 'MyCode · ' + project.name, cwd);
	t.sendText(fn.cmd);
	status('已执行 · ' + project.name + ' · ' + fn.label + '：' + fn.cmd);
}

function openFolder(dir) {
	if (!dir || !fs.existsSync(dir)) { status('路径不存在：' + dir); return; }
	vscode.env.openExternal(vscode.Uri.file(dir));
	status('已打开：' + dir);
}

async function openUrl(url, label) {
	if (!url) { status('地址为空'); return; }
	await vscode.env.openExternal(vscode.Uri.parse(url));
	status('已打开' + (label ? ' · ' + label : '') + '：' + url);
}

function sshBase(server) {
	let s = 'ssh -tt -o StrictHostKeyChecking=accept-new';
	if (server.key) s += ' -i "' + normPath(server.key) + '"';
	s += ' -p ' + (server.port || 22) + ' ' + (server.user || 'root') + '@' + (server.host || '');
	return s;
}

function connectServer(server) {
	const key = 'server:' + server.id;
	const t = terminalFor(key, 'SSH · ' + server.name);
	if (!interactive.has(key)) {
		t.sendText(sshBase(server));
		interactive.add(key);
		status('SSH 终端已就绪 · ' + server.name + '（在集成终端里输入密码；配置密钥后可实现一键执行）');
	}
}

function runServer(server, fn) {
	const key = 'server:' + server.id;
	const t = terminalFor(key, 'SSH · ' + server.name);
	if (interactive.has(key)) {
		// 已登录的交互会话：直接注入命令，不重连、不重复敲
		t.sendText(fn.cmd);
		status('已发送 · ' + server.name + ' · ' + fn.label + '：' + fn.cmd);
	} else {
		// 未建立交互会话：用一次性 ssh 执行，输出仍在同一终端
		const cmd = String(fn.cmd).replace(/"/g, '\\"');
		t.sendText(sshBase(server) + ' "' + cmd + '"');
		status('已执行 · ' + server.name + ' · ' + fn.label + '：' + fn.cmd);
	}
}

async function openSite(site, mode) {
	const url = site.url || '';
	if (!url) { status('后台地址为空，请点「编辑配置」填写 url'); return; }
	if (mode === 'ide') {
		try {
			await vscode.commands.executeCommand('simpleBrowser.show', url);
			status('已在 IDE 内打开：' + url);
			return;
		} catch (err) {
			// 内置 Simple Browser 不可用时回退到系统浏览器
		}
	}
	await vscode.env.openExternal(vscode.Uri.parse(url));
	status('已打开管理后台：' + url);
}

async function editConfig() {
	try {
		const doc = await vscode.workspace.openTextDocument(defaultConfigPath());
		await vscode.window.showTextDocument(doc, { preview: false });
		status('正在编辑配置，保存后面板会自动刷新');
	} catch (err) {
		status('打开配置失败：' + (err && err.message || err));
	}
}

function status(text) {
	if (panelProvider) panelProvider.post({ type: 'status', text: text });
}

/* -------------------------------- Webview -------------------------------- */

class PanelProvider {
	constructor() { this.view = null; }

	resolveWebviewView(view) {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = getHtml(view.webview);
		view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
		view.onDidDispose(() => { this.view = null; });
		this.refresh();
	}

	post(msg) { if (this.view) this.view.webview.postMessage(msg); }

	refresh() {
		const cfg = loadConfig();
		cfg.auto_detect = vscode.workspace.getConfiguration('mycodeTools').get('autoDetect') !== false;
		this.post({ type: 'config', config: cfg });
	}

	async onMessage(msg) {
		const cfg = loadConfig();
		if (msg.type === 'refresh') { this.refresh(); return; }
		if (msg.type === 'rescan') { rescan(true); return; }
		if (msg.type === 'editConfig') { await editConfig(); return; }

		if (msg.type === 'action' && msg.section === 'project') {
			const p = cfg.projects.find(x => x.id === msg.id);
			const fn = p && (p.functions || []).find(f => f.key === msg.key);
			if (!p || !fn) return;
			if (fn.ready === false) {
				status('无法执行（缺少：' + (fn.missing || []).join('、') + '）依据：' + (fn.evidence || '—'));
				return;
			}
			if (fn.type === 'run') runLocal(p, fn);
			else if (fn.type === 'url') await openUrl(fn.cmd, fn.label);
			else if (fn.type === 'open') {
				const root = normPath(p.path);
				const direct = fn.cmd && !fn.target; // 扫描器给出绝对路径
				const target = direct ? fn.cmd
					: (fn.target && fn.target !== 'folder' ? path.join(root, fn.target) : root);
				openFolder(fs.existsSync(target) ? target : root);
			} else if (fn.type === 'note') status(fn.note || fn.text || fn.evidence || '');
			return;
		}

		if (msg.type === 'openProjectDir') {
			const p = cfg.projects.find(x => x.id === msg.id);
			if (p) openFolder(normPath(p.path));
			return;
		}

		if (msg.type === 'openFunctionUrl') {
			const p = cfg.projects.find(x => x.id === msg.id);
			const fn = p && (p.functions || []).find(f => f.key === msg.key);
			if (fn) await openUrl(fn.cmd, fn.label);
			return;
		}

		if (msg.type === 'interrupt') {
			const keys = msg.section === 'server'
				? ['server:' + msg.id]
				: ['project:' + msg.id];
			for (const k of keys) {
				const t = terminals.get(k);
				if (t) { t.show(true); t.sendText('\u0003', false); }
			}
			status('已发送中断（Ctrl+C）');
			return;
		}

		if (msg.section === 'server' || msg.type === 'connect' || msg.type === 'disconnect') {
			const s = cfg.servers.find(x => x.id === msg.id);
			if (!s) return;
			if (msg.type === 'connect') { connectServer(s); return; }
			if (msg.type === 'disconnect') { disposeTerminal('server:' + s.id); status('已断开 · ' + s.name); return; }
			if (msg.type === 'action') {
				const fn = (s.functions || []).find(f => f.key === msg.key);
				if (!fn) return;
				if (fn.type === 'note') { status(fn.text || fn.note || '（依据：' + (fn.evidence || '—') + '）'); return; }
				runServer(s, fn);
			}
			return;
		}

		if (msg.section === 'member' || msg.type === 'openSite') {
			const s = cfg.admin_sites.find(x => x.id === msg.id);
			if (s) await openSite(s, msg.mode);
		}
	}
}

function getHtml(webview) {
	const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
	const csp = "default-src 'none'; style-src " + webview.cspSource + " 'unsafe-inline'; script-src 'nonce-" + nonce + "';";
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
         color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
  .tabs { display:flex; border-bottom:1px solid var(--vscode-panel-border); }
  .tab { flex:1; padding:9px 2px; background:transparent; border:0; border-bottom:2px solid transparent;
         color:var(--vscode-descriptionForeground); cursor:pointer; font-size:12px; font-family:inherit; }
  .tab:hover { color:var(--vscode-foreground); }
  .tab.active { color:var(--vscode-foreground); border-bottom-color:var(--vscode-focusBorder); font-weight:600; }
  .section { display:none; padding:10px; }
  .section.active { display:block; }
  .cap { font-size:11px; color:var(--vscode-descriptionForeground); margin:0 0 6px; }
  .list { border:1px solid var(--vscode-panel-border); border-radius:3px; max-height:190px; overflow:auto; }
  .item { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:6px 8px; cursor:pointer;
          border-bottom:1px solid var(--vscode-panel-border); font-size:12px; }
  .item:last-child { border-bottom:0; }
  .item:hover { background:var(--vscode-list-hoverBackground); }
  .item.active { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); }
  .item .tag { font-size:10px; opacity:.75; white-space:nowrap; }
  .empty { padding:10px; font-size:11px; color:var(--vscode-descriptionForeground); }
  .detail { margin-top:12px; }
  .title { font-size:13px; font-weight:600; margin:0 0 3px; }
  .sub { font-size:11px; color:var(--vscode-descriptionForeground); word-break:break-all; margin:0 0 9px; line-height:1.5; }
  .actions { display:flex; flex-wrap:wrap; gap:6px; }
  .act { padding:5px 10px; font-size:12px; font-family:inherit; cursor:pointer; border-radius:2px;
         border:1px solid transparent; background:var(--vscode-button-secondaryBackground);
         color:var(--vscode-button-secondaryForeground); }
  .act:hover { background:var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground)); }
  .act.primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  .act.primary:hover { background:var(--vscode-button-hoverBackground); }
  .act:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:1px; }
  .hint { font-size:11px; color:var(--vscode-descriptionForeground); margin:8px 0 0; line-height:1.5; }
  .status { margin-top:12px; padding:7px 8px; font-size:11px; line-height:1.5; min-height:30px;
            background:var(--vscode-textCodeBlock-background); color:var(--vscode-descriptionForeground);
            border-radius:3px; word-break:break-word; }
  .act:disabled { opacity:.5; cursor:not-allowed; }
  .meta { font-size:10px; color:var(--vscode-descriptionForeground); margin:0 0 8px; line-height:1.5; }
  .evbox { margin-top:9px; border-top:1px solid var(--vscode-panel-border); padding-top:7px; }
  .evhead { font-size:10px; color:var(--vscode-descriptionForeground); margin:0 0 4px; letter-spacing:.3px; }
  .ev { font-size:10px; line-height:1.55; color:var(--vscode-descriptionForeground); margin:0 0 3px;
        word-break:break-all; }
  .ev b { color:var(--vscode-foreground); font-weight:600; }
  .ev .cmd { display:block; font-family:var(--vscode-editor-font-family, monospace); opacity:.85; }
  .ev.warn { color:var(--vscode-inputValidation-warningForeground, var(--vscode-editorWarning-foreground)); }
  footer { display:flex; gap:12px; padding:8px 10px; border-top:1px solid var(--vscode-panel-border); flex-wrap:wrap; }
  .link { background:transparent; border:0; padding:2px 0; cursor:pointer; font-size:11px; font-family:inherit;
          color:var(--vscode-textLink-foreground); }
  .link:hover { text-decoration:underline; }
  .scanbar { padding:7px 10px 0; font-size:10px; color:var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" data-tab="project">项目</button>
    <button class="tab" data-tab="server">运维</button>
    <button class="tab" data-tab="member">会员后台</button>
  </div>

  <div class="section active" id="sec-project">
    <p class="cap">项目</p>
    <div class="list" id="list-project"></div>
    <div class="detail" id="detail-project"></div>
  </div>

  <div class="section" id="sec-server">
    <p class="cap">服务器</p>
    <div class="list" id="list-server"></div>
    <div class="detail" id="detail-server"></div>
  </div>

  <div class="section" id="sec-member">
    <p class="cap">管理后台</p>
    <div class="list" id="list-member"></div>
    <div class="detail" id="detail-member"></div>
  </div>

  <div class="scanbar" id="scanbar"></div>
  <footer>
    <button class="link" id="btn-rescan">重新探测项目结构</button>
    <button class="link" id="btn-refresh">刷新</button>
    <button class="link" id="btn-config">编辑配置</button>
    <button class="link" id="btn-interrupt">中断 (Ctrl+C)</button>
  </footer>

<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var cfg = { projects: [], servers: [], admin_sites: [] };
  var section = 'project';
  var selected = { project: null, server: null, member: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function post(m) { vscode.postMessage(m); }

  function renderList(el, items, key, labelFn, tagFn) {
    if (!items.length) { el.innerHTML = '<div class="empty">暂无数据，点下方「编辑配置」添加</div>'; return; }
    el.innerHTML = items.map(function (it) {
      var active = selected[key] === it.id ? ' active' : '';
      return '<div class="item' + active + '" data-id="' + esc(it.id) + '">' +
               '<span>' + esc(labelFn(it)) + '</span>' +
               '<span class="tag">' + esc(tagFn(it)) + '</span></div>';
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('.item'), function (node) {
      node.addEventListener('click', function () {
        selected[key] = node.getAttribute('data-id');
        renderAll();
      });
    });
  }

  function actionButtons(sectionName, id, fns) {
    var first = true;
    return fns.map(function (f) {
      if (f.type === 'note') return '';
      var cls = 'act' + (first ? ' primary' : '');
      first = false;
      var disabled = f.ready === false ? ' disabled title="缺少依赖，见下方依据"' : '';
      if (f.type === 'url' || (sectionName === 'project' && f.key === 'localSite')) {
        return '<button class="' + cls + '"' + disabled +
          ' data-cmd="' + cmd({ type: 'openFunctionUrl', section: sectionName, id: id, key: f.key }) + '">' +
          esc(f.label) + '</button>';
      }
      return '<button class="' + cls + '"' + disabled + ' data-action="1" data-key="' + esc(f.key) + '">' +
             esc(f.label) + '</button>';
    }).join('');
  }

  function notes(fns) {
    return fns.filter(function (f) { return f.type === 'note' && (f.text || f.note); })
              .map(function (f) { return '<p class="hint">' + esc(f.note || f.text) + '</p>'; }).join('');
  }

  // 把探测到的依据逐条列出来，按钮不再是黑盒
  function evidenceBox(fns) {
    var rows = fns.map(function (f) {
      var detail = f.type === 'note' ? (f.note || f.text || '')
                 : (f.cmd || '') + (f.evidence ? '  ←  ' + f.evidence : '');
      if (f.ready === false) detail += '  [缺少：' + (f.missing || []).join('、') + ']';
      var cls = 'ev' + (f.ready === false ? ' warn' : '');
      return '<div class="' + cls + '"><b>' + esc(f.label) + '</b><span class="cmd">' + esc(detail) + '</span></div>';
    }).join('');
    return rows ? '<div class="evbox"><div class="evhead">探测依据 / 将执行的命令</div>' + rows + '</div>' : '';
  }

  function structureLine(p) {
    if (!p.structure || !p.structure.length) return '';
    return '<div class="meta">检测到：' + esc(p.structure.join(' · ')) + '</div>';
  }

  function bindDetail(sectionName, id) {
    var wrap = document.getElementById('detail-' + sectionName);
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-action]'), function (btn) {
      btn.addEventListener('click', function () {
        post({ type: 'action', section: sectionName, id: id, key: btn.getAttribute('data-key') });
      });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-cmd]'), function (btn) {
      btn.addEventListener('click', function () {
        post(JSON.parse(btn.getAttribute('data-cmd')));
      });
    });
  }

  function cmd(o) { return esc(JSON.stringify(o)); }

  function renderProject() {
    var items = cfg.projects;
    renderList(document.getElementById('list-project'), items, 'project',
      function (p) { return p.name; }, function (p) { return p.tech || ''; });
    var p = items.find(function (x) { return x.id === selected.project; }) || items[0];
    var d = document.getElementById('detail-project');
    if (!p) { d.innerHTML = ''; return; }
    selected.project = p.id;
    var fns = p.functions || [];
    d.innerHTML =
      '<div class="title">' + esc(p.name) + '</div>' +
      '<div class="sub">' + esc(p.path || '') + '</div>' +
      structureLine(p) +
      '<div class="actions">' + actionButtons('project', p.id, fns) +
        '<button class="act" data-cmd="' + cmd({ type: 'openProjectDir', section: 'project', id: p.id }) + '">打开目录</button>' +
      '</div>' + notes(fns) + evidenceBox(fns);
    bindDetail('project', p.id);
  }

  function renderServer() {
    var items = cfg.servers;
    renderList(document.getElementById('list-server'), items, 'server',
      function (s) { return s.name; }, function (s) { return (s.user || '') + '@' + (s.host || ''); });
    var s = items.find(function (x) { return x.id === selected.server; }) || items[0];
    var d = document.getElementById('detail-server');
    if (!s) { d.innerHTML = ''; return; }
    selected.server = s.id;
    var fns = s.functions || [];
    d.innerHTML =
      '<div class="title">' + esc(s.name) + '</div>' +
      '<div class="sub">' + esc((s.user || 'root') + '@' + (s.host || '') + ':' + (s.port || 22)) +
        (s.key ? ' · 密钥 ' + esc(s.key) : '') + '</div>' +
      (s.evidence ? '<div class="meta">探测依据：' + esc(s.evidence) + '</div>' : '') +
      '<div class="actions">' +
        '<button class="act primary" data-cmd="' + cmd({ type: 'connect', section: 'server', id: s.id }) + '">连接 SSH 终端</button>' +
        actionButtons('server', s.id, fns) +
        '<button class="act" data-cmd="' + cmd({ type: 'disconnect', section: 'server', id: s.id }) + '">断开</button>' +
      '</div>' +
      '<p class="hint">在集成终端里可以直接敲命令；上面的按钮会把命令自动注入同一终端。</p>' +
      notes(fns) + evidenceBox(fns);
    bindDetail('server', s.id);
  }

  function renderMember() {
    var items = cfg.admin_sites;
    renderList(document.getElementById('list-member'), items, 'member',
      function (s) { return s.name; }, function () { return '网页'; });
    var s = items.find(function (x) { return x.id === selected.member; }) || items[0];
    var d = document.getElementById('detail-member');
    if (!s) { d.innerHTML = ''; return; }
    selected.member = s.id;
    d.innerHTML =
      '<div class="title">' + esc(s.name) + '</div>' +
      '<div class="sub">' + esc(s.url || '') + '</div>' +
      (s.note ? '<div class="meta">' + esc(s.note) + '</div>' : '') +
      '<div class="actions">' +
        '<button class="act primary" data-cmd="' + cmd({ type: 'openSite', section: 'member', id: s.id, mode: 'browser' }) + '">打开管理后台</button>' +
        '<button class="act" data-cmd="' + cmd({ type: 'openSite', section: 'member', id: s.id, mode: 'ide' }) + '">在 IDE 内打开</button>' +
      '</div>';
    bindDetail('member', s.id);
  }

  function renderAll() {
    renderProject(); renderServer(); renderMember();
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-tab') === section);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.section'), function (sec) {
      sec.classList.toggle('active', sec.id === 'sec-' + section);
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
    tab.addEventListener('click', function () {
      section = tab.getAttribute('data-tab');
      renderAll();
    });
  });

  document.getElementById('btn-rescan').addEventListener('click', function () {
    document.getElementById('scanbar').textContent = '正在扫描项目结构…';
    post({ type: 'rescan' });
  });
  document.getElementById('btn-refresh').addEventListener('click', function () { post({ type: 'refresh' }); });
  document.getElementById('btn-config').addEventListener('click', function () { post({ type: 'editConfig' }); });
  document.getElementById('btn-interrupt').addEventListener('click', function () {
    var id = selected[section];
    if (id) post({ type: 'interrupt', section: section, id: id });
  });

  window.addEventListener('message', function (ev) {
    var m = ev.data || {};
    if (m.type === 'config') {
      cfg = m.config || cfg;
      var when = cfg.scanned_at ? new Date(cfg.scanned_at).toLocaleString() : '未扫描';
      document.getElementById('scanbar').textContent =
        '项目结构探测：' + when + ' · ' + (cfg.projects || []).length + ' 个项目' +
        (cfg.auto_detect === false ? '' : ' · 新项目自动发现');
      if (cfg.error) { document.querySelector('.status') && (document.querySelector('.status').textContent = cfg.error); }
      ['project', 'server', 'member'].forEach(function (k) {
        var list = k === 'project' ? cfg.projects : k === 'server' ? cfg.servers : cfg.admin_sites;
        if (selected[k] && list && !list.some(function (x) { return x.id === selected[k]; })) selected[k] = null;
      });
      renderAll();
    } else if (m.type === 'status') {
      var el = document.createElement('div');
      el.className = 'status';
      el.textContent = m.text || '';
      var old = document.querySelector('.status');
      if (old) old.parentNode.replaceChild(el, old);
      else document.querySelector('footer').parentNode.insertBefore(el, document.querySelector('footer'));
    }
  });

  renderAll();
  post({ type: 'refresh' });
})();
</script>
</body>
</html>`;
}

/* -------------------------------- 生命周期 -------------------------------- */

/** 增量探测：新目录自动加入，不覆盖用户对已有项目的手工命令。 */
function autoRescan() {
	try {
		const prev = loadConfig();
		const fresh = scanner.scan(projectsRoot());
		if (!prev.projects || !prev.projects.length) return rescan(true);
		const { config, added, upgraded, removed } = scanner.merge(prev, fresh);
		fs.writeFileSync(defaultConfigPath(), JSON.stringify(config, null, 2), 'utf8');
		if (panelProvider) panelProvider.refresh();
		const parts = [];
		if (added.length) parts.push('新项目 ' + added.map(p => p.name).join('、'));
		if (upgraded.length) parts.push('识别到技术栈 ' + upgraded.map(p => p.name).join('、'));
		if (removed.length) parts.push('已移除 ' + removed.map(p => p.name).join('、'));
		if (parts.length) status('项目结构已更新：' + parts.join('；'));
		return config;
	} catch (err) {
		console.error('[mycode-tools] autoRescan:', err);
		return null;
	}
}

/* ------------------------------ 目录监听（新项目自动发现） ------------------------------ */

let watcher = null;
let watchTimer = null;

function stopWatcher() {
	if (watcher) { try { watcher.close(); } catch (_) { /* noop */ } }
	watcher = null;
	if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
}

function startWatcher() {
	stopWatcher();
	const enabled = vscode.workspace.getConfiguration('mycodeTools').get('autoDetect');
	if (enabled === false) return;
	const root = projectsRoot();
	try {
		// 只监听根目录一层：新建/删除/改名项目文件夹都会触发，开销极小
		watcher = fs.watch(root, { persistent: false }, () => {
			if (watchTimer) clearTimeout(watchTimer);
			watchTimer = setTimeout(() => { watchTimer = null; autoRescan(); }, 1500);
		});
		watcher.on('error', (e) => console.error('[mycode-tools] watcher:', e));
	} catch (err) {
		console.error('[mycode-tools] startWatcher:', err);
	}
}

function activate(context) {
	extContext = context;
	ensureUserConfig();
	panelProvider = new PanelProvider();
	startWatcher();

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('mycodeTools.panel', panelProvider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('mycodeTools.refresh', () => panelProvider && panelProvider.refresh()),
		vscode.commands.registerCommand('mycodeTools.rescan', () => rescan(true)),
		vscode.commands.registerCommand('mycodeTools.editConfig', () => editConfig())
	);

	context.subscriptions.push(
		vscode.window.onDidCloseTerminal((t) => {
			for (const [key, value] of terminals) {
				if (value === t) { terminals.delete(key); interactive.delete(key); }
			}
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (doc.uri.toString() === vscode.Uri.file(defaultConfigPath()).toString()) {
				panelProvider && panelProvider.refresh();
				status('配置已保存，面板已刷新');
			}
		})
	);
}

function deactivate() {
	stopWatcher();
	for (const key of Array.from(terminals.keys())) disposeTerminal(key);
}

module.exports = { activate, deactivate };
