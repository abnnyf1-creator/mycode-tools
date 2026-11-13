/*---------------------------------------------------------------------------------------------
 *  MyCode 项目结构扫描器
 *  真实读取项目根目录下每个项目的文件结构、自带脚本、工具链与部署资料，
 *  据此生成「源码启动 / 打包分发 / 官网维护」命令与服务器、后台地址。
 *  每条命令都带 evidence（依据文件）与 requires（依赖检查），避免按钮是空壳。
 *  纯 Node，无第三方依赖；既可被扩展 require，也可命令行直接运行生成配置。
 *--------------------------------------------------------------------------------------------*/

const fs = require('fs');
const os = require('os');
const path = require('path');

// 用户目录相关候选路径（不写死具体用户名）
const HOME = os.homedir();
const HOME_APP = path.join(HOME, 'AppData', 'Local');

// 探测逻辑版本：升级后首次启动会自动重扫一次（老配置里没有该版本号）
const SCANNER_VERSION = 2;

const EXCLUDE_DIRS = new Set([
	'.git', '.workbuddy', '.vscode', '.idea', 'node_modules', '__pycache__',
	'devDependencies', 'WinCache', 'Temp', 'MyCodeTool'
]);

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function listDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }
function fwd(p) { return String(p).replace(/\\/g, '/'); }
function win(p) { return String(p).replace(/\//g, '\\'); }
function q(p) { return '"' + win(p) + '"'; }
// MSYS2 bash 不认 "D:/..." 这种盘符路径，需转成 "/d/..."
function msys(p) {
	const s = fwd(p);
	return s.replace(/^([A-Za-z]):\//, (_, drive) => '/' + drive.toLowerCase() + '/');
}

/* ------------------------------ 工具链探测 ------------------------------ */

function firstExisting(candidates) {
	for (const c of candidates) {
		const p = win(c);
		if (exists(p)) return p;
	}
	return null;
}

/** 在 PATH 里找可执行文件（新工具链装到哪都能发现，不写死绝对路径）。 */
function pathLookup(names) {
	const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
	const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
	for (const n of names) {
		for (const d of dirs) {
			for (const e of exts) {
				const p = path.join(d, n + e);
				if (isFile(p)) return win(p);
			}
		}
	}
	return null;
}

function exeIn(dir, re) {
	for (const e of listDir(dir)) if (e.isFile() && re.test(e.name)) return win(path.join(dir, e.name));
	return null;
}

/** 版本无关地找 Godot：目录里只要有 Godot*.exe 即可（升级版本不再失配）。 */
function findGodot(root) {
	const dirs = [
		'D:/Godot', 'C:/Godot',
		'C:/Program Files/Godot', 'C:/Program Files (x86)/Godot',
		path.join(HOME_APP, 'Programs', 'Godot'),
		path.join(root, 'devDependencies')
	];
	for (const d of dirs) {
		if (!isDir(d)) continue;
		const hit = exeIn(d, /^Godot.*\.exe$/i);
		if (hit) return hit;
		for (const e of listDir(d)) {
			if (!e.isDirectory()) continue;
			const inner = exeIn(path.join(d, e.name), /^Godot.*\.exe$/i);
			if (inner) return inner;
		}
	}
	return null;
}

/** 找 VSCode 派生版的已构建可执行文件：项目下的 VSCode-win32-[arch] 目录。 */
function findIDeExe(root) {
	for (const e of listDir(root)) {
		if (!e.isDirectory()) continue;
		const base = path.join(root, e.name);
		for (const sub of listDir(base)) {
			if (!sub.isDirectory() || !/^VSCode-win32-/i.test(sub.name)) continue;
			const dir = path.join(base, sub.name);
			const named = exeIn(dir, /^(Code|VSCodium|Cursor)\.exe$/i);
			if (named) return named;
			const any = exeIn(dir, /\.exe$/i);
			if (any) return any;
		}
	}
	return null;
}

function detectToolchain(root) {
	const tc = {};
	tc.flutter = firstExisting([
		path.join(root, 'devDependencies/flutter/bin/flutter.bat'),
		'C:/flutter/bin/flutter.bat',
		'C:/src/flutter/bin/flutter.bat'
	]) || pathLookup(['flutter']);
	tc.msysBash = firstExisting([
		'C:/msys64/usr/bin/bash.exe',
		'D:/msys64/usr/bin/bash.exe'
	]);
	tc.cmake = firstExisting([
		'C:/msys64/mingw64/bin/cmake.exe',
		path.join(HOME_APP, 'Microsoft', 'WinGet', 'Links', 'cmake.exe')
	]);
	tc.godot = findGodot(root) || firstExisting([
		'C:/Program Files/Godot/Godot.exe'
	]);
	tc.python = firstExisting([
		path.join(HOME_APP, 'Programs', 'Python', 'Python312', 'python.exe'),
		'C:/Python312/python.exe',
		'C:/Python311/python.exe'
	]) || pathLookup(['python', 'python3']);
	tc.ideExe = findIDeExe(root);
	// 其他常见栈：从 PATH 动态发现，避免只认写死的路径
	tc.node = pathLookup(['node']);
	tc.npm = pathLookup(['npm']);
	tc.cargo = pathLookup(['cargo']);
	tc.go = pathLookup(['go']);
	tc.dotnet = pathLookup(['dotnet']);
	tc.gradle = pathLookup(['gradle']);
	tc.java = pathLookup(['java']);
	return tc;
}

/* ------------------------------ 通用助手 ------------------------------ */

function makeFn(key, label, type, cmd, evidence, requires, note) {
	const missing = (requires || []).filter(r => !exists(r));
	return {
		key, label, type, cmd: cmd || '',
		evidence: evidence || '',
		requires: requires || [],
		ready: missing.length === 0,
		missing,
		...(note ? { note } : {})
	};
}

function siteFn(dir, root) {
	// 官网维护：优先真实官网目录 / 官网 URL，其次 docs，其次 README；没有就明确说明
	const official = path.join(dir, 'official-site');
	const sitemap = path.join(official, 'sitemap.xml');
	if (isDir(official)) {
		const sm = read(sitemap);
		const m = sm.match(/<loc>\s*([^<]+?)\s*<\/loc>/);
		const url = m ? m[1].trim() : '';
		const html = listDir(official).filter(e => e.isFile() && /\.html?$/i.test(e.name)).map(e => e.name);
		const fns = [makeFn('web', '官网源码', 'open', fwd(official),
			'official-site/ 目录' + (html.length ? '（' + html.join(', ') + '）' : ''), [official])];
		if (url) fns.push(makeFn('webUrl', '打开官网', 'url', url, 'official-site/sitemap.xml 的 <loc>', []));
		fns.push(makeFn('docs', '文档', 'open', fwd(path.join(dir, 'docs')),
			'docs/ 目录', [path.join(dir, 'docs')]));
		return fns;
	}
	const docs = path.join(dir, 'docs');
	if (isDir(docs) && listDir(docs).length) {
		return [makeFn('web', '文档 / 官网资料', 'open', fwd(docs),
			'docs/ 目录（未发现独立官网目录）', [docs])];
	}
	const readme = path.join(dir, 'README.md');
	if (exists(readme)) {
		return [makeFn('web', '项目说明', 'open', fwd(readme),
			'README.md（未发现 docs/ 或官网目录）', [readme])];
	}
	return [makeFn('web', '官网维护', 'note', '',
		'未检测到官网目录、docs/ 或 README.md；请在配置里手动补充', [],
		'此项目没有可探查到的官网/文档资料')];
}

function structureOf(dir) {
	const items = [];
	const probes = [
		'pubspec.yaml', 'lib/main.dart', 'windows/CMakeLists.txt', 'web/index.html',
		'android/build.gradle.kts', 'ios/Runner.xcodeproj', 'settings.gradle.kts',
		'gradlew.bat', 'CMakeLists.txt', 'tools/build.sh', 'tools/run.sh',
		'project.godot', 'export_presets.cfg', 'run.py',
		'code-oss/product.json', 'official-site', 'deploy', 'docs', 'installer',
		'package.json', 'Cargo.toml', 'go.mod', 'index.html', 'pyproject.toml', 'requirements.txt'
	];
	for (const p of probes) if (exists(path.join(dir, p))) items.push(p);
	return items;
}

/* ------------------------------ 各技术栈探测 ------------------------------ */

function detectFlutter(dir, name, tc, root) {
	const pub = read(path.join(dir, 'pubspec.yaml'));
	const pm = pub.match(/^name:\s*(.+)$/m);
	const pkg = pm ? pm[1].trim() : name;
	const hasWindows = exists(path.join(dir, 'windows/CMakeLists.txt'));
	const hasWeb = exists(path.join(dir, 'web/index.html'));
	const hasAndroid = isDir(path.join(dir, 'android'));
	const platform = hasWindows ? 'windows' : hasWeb ? 'web' : hasAndroid ? 'android' : '';
	const platformEvidence = hasWindows ? 'windows/CMakeLists.txt' : hasWeb ? 'web/index.html' : 'android/';
	const flutter = tc.flutter;
	const fns = [];

	// 源码启动：按真实存在的平台目录决定 target，绝不再盲写 -d windows
	if (platform === 'windows' || platform === 'web') {
		const target = platform === 'windows' ? 'windows' : 'chrome';
		fns.push(makeFn('launch', '源码启动', 'run',
			'call ' + q(flutter) + ' run -d ' + target,
			'pubspec.yaml（' + pkg + '）+ ' + platformEvidence + ' + 工具链 ' + fwd(flutter),
			[path.join(dir, 'pubspec.yaml'), path.join(dir, platform === 'windows' ? 'windows/CMakeLists.txt' : 'web/index.html'), flutter]));
	} else if (platform === 'android') {
		fns.push(makeFn('launch', '查看设备', 'run',
			'call ' + q(flutter) + ' devices',
			'android/ 存在但无 windows/ 与 web/；先列设备再用 -d <设备ID> 启动',
			[path.join(dir, 'pubspec.yaml'), flutter],
			'未发现桌面/Web 平台目录，需连接 Android 设备后手动指定 -d'));
	} else {
		fns.push(makeFn('launch', '源码启动', 'note', '',
			'pubspec.yaml 存在，但未发现任何平台目录', [], '缺少 windows/、web/、android/，无法确定启动目标'));
	}

	// 打包分发：优先项目自带构建脚本（比通用 flutter build 更贴近真实流程）
	const toolDir = path.join(dir, 'tool');
	const toolRoot = path.join(dir, 'tools');
	const ownScripts = [];
	for (const d of [toolDir, toolRoot]) {
		if (!isDir(d)) continue;
		for (const e of listDir(d)) {
			if (e.isFile() && /\.(bat|ps1)$/i.test(e.name) && /build|release|web|apk/i.test(e.name)) {
				ownScripts.push(path.join(d, e.name));
			}
		}
	}
	const apkScript = ownScripts.find(p => /android|apk|release/i.test(path.basename(p)) && /\.bat$/i.test(p));
	const webScript = ownScripts.find(p => /web/i.test(path.basename(p)));

	if (apkScript) {
		fns.push(makeFn('build', '打包 APK', 'run', 'call ' + q(apkScript),
			fwd(path.relative(root, apkScript)) + '（项目自带发布脚本，内含 Flutter SDK 路径回退）', [apkScript]));
	} else if (platform === 'windows') {
		fns.push(makeFn('build', '打包分发', 'run', 'call ' + q(flutter) + ' build windows --release',
			'pubspec.yaml + windows/CMakeLists.txt', [path.join(dir, 'windows/CMakeLists.txt'), flutter]));
	} else if (hasWeb) {
		fns.push(makeFn('build', '打包 Web', 'run', 'call ' + q(flutter) + ' build web --release --no-tree-shake-icons',
			'pubspec.yaml + web/index.html（参数参考项目 README）', [path.join(dir, 'web/index.html'), flutter]));
	} else if (hasAndroid) {
		fns.push(makeFn('build', '打包 APK', 'run', 'call ' + q(flutter) + ' build apk --release',
			'pubspec.yaml + android/', [path.join(dir, 'android'), flutter]));
	}
	if (webScript && webScript !== apkScript) {
		fns.push(makeFn('buildWeb', '打包 Web', 'run',
			'powershell -ExecutionPolicy Bypass -File ' + q(webScript),
			fwd(path.relative(root, webScript)) + '（项目自带 Web 构建脚本）', [webScript]));
	}
	return { tech: 'flutter', platform, fns, pkg };
}

function detectAndroid(dir, name, tc, root) {
	const gradlew = path.join(dir, 'gradlew.bat');
	const settings = path.join(dir, 'settings.gradle.kts');
	const fns = [
		makeFn('launch', '源码启动', 'run', 'call ' + q(gradlew) + ' installDebug',
			'gradlew.bat + settings.gradle.kts（安装到已连接设备）', [gradlew, settings],
			'需要 adb 已连接设备；仅构建可改用「打包分发」'),
		makeFn('build', '打包分发', 'run', 'call ' + q(gradlew) + ' assembleRelease',
			'gradlew.bat + app/build.gradle.kts', [gradlew, path.join(dir, 'app/build.gradle.kts')])
	];
	const check = path.join(dir, 'tools/release-check.ps1');
	if (exists(check)) {
		fns.push(makeFn('verify', '发布前检查', 'run', 'powershell -ExecutionPolicy Bypass -File ' + q(check),
			'tools/release-check.ps1（项目自带只读检查脚本）', [check]));
	}
	return { tech: 'android', fns };
}

function detectCMake(dir, name, tc, root) {
	const bash = tc.msysBash;
	const fns = [];
	const launchBat = findLaunchBat(dir);
	const runSh = path.join(dir, 'tools/run.sh');
	const buildSh = path.join(dir, 'tools/build.sh');
	const probeSh = path.join(dir, 'tools/build-probe.sh');
	const runTestsSh = path.join(dir, 'tools/run-tests.sh');
	const cd = 'cd ' + msys(dir) + ' && ';

	// 启动脚本文件名含中文时，cmd 可能因代码页不匹配找不到；有 tools/run.sh 就直接调它。
	if (exists(runSh)) {
		fns.push(makeFn('launch', '源码启动', 'run',
			q(bash) + ' -lc "' + cd + './tools/run.sh"',
			'tools/run.sh + MSYS2 bash（与项目自带启动脚本等价，且不受 cmd 代码页影响）',
			[runSh, bash]));
	} else if (launchBat) {
		fns.push(makeFn('launch', '源码启动', 'run', 'call ' + q(launchBat),
			fwd(path.relative(root, launchBat)) + '（项目自带启动脚本）', [launchBat]));
	} else if (exists(runTestsSh)) {
		fns.push(makeFn('launch', '运行探针', 'run',
			q(bash) + ' -lc "' + cd + './tools/run-tests.sh"',
			'tools/run-tests.sh + MSYS2 bash', [runTestsSh, bash]));
	}

	const buildScript = exists(buildSh) ? buildSh : exists(probeSh) ? probeSh : null;
	if (buildScript) {
		fns.push(makeFn('build', '打包分发', 'run',
			q(bash) + ' -lc "' + cd + './' + fwd(path.relative(dir, buildScript)) + '"',
			fwd(path.relative(root, buildScript)) + ' + MSYS2 bash / Ninja', [buildScript, bash]));
	} else {
		fns.push(makeFn('build', '打包分发', 'run',
			q(bash) + ' -lc "' + cd + 'cmake --build build"',
			'CMakeLists.txt + 已存在的 build/ 目录', [path.join(dir, 'CMakeLists.txt'), bash]));
	}
	return { tech: 'cmake_cpp', fns };
}

function findLaunchBat(dir) {
	for (const e of listDir(dir)) {
		if (e.isFile() && /\.bat$/i.test(e.name) && /启动|launch|run/i.test(e.name)) {
			return path.join(dir, e.name);
		}
	}
	return null;
}

function detectGodot(dir, name, tc, root) {
	const godot = tc.godot;
	const proj = path.join(dir, 'project.godot');
	const presets = path.join(dir, 'export_presets.cfg');
	const fns = [makeFn('launch', '源码启动', 'run',
		q(godot) + ' --editor --path .',
		'project.godot + Godot v4.7.2（' + fwd(godot) + '）', [proj, godot])];

	if (exists(presets)) {
		const txt = read(presets);
		const nm = txt.match(/^name\s*=\s*"([^"]+)"/m);
		const em = txt.match(/^export_path\s*=\s*"([^"]+)"/m);
		const preset = nm ? nm[1] : 'Windows Desktop';
		const out = em ? em[1] : 'build/windows/export.exe';
		fns.push(makeFn('build', '打包分发', 'run',
			q(godot) + ' --headless --path . --export-release "' + preset + '" "' + out + '"',
			'export_presets.cfg（preset: ' + preset + '，输出: ' + out + '）', [presets, godot]));
	} else {
		fns.push(makeFn('build', '打包分发', 'note', '',
			'未发现 export_presets.cfg', [], '该项目没有导出预设，无法一键打包'));
	}
	return { tech: 'godot', fns };
}

function detectPython(dir, name, tc, root) {
	const py = tc.python;
	const runPy = path.join(dir, 'run.py');
	const spec = listDir(dir).find(e => e.isFile() && /\.spec$/i.test(e.name));
	const specPath = spec ? path.join(dir, spec.name) : null;
	const fns = [makeFn('launch', '源码启动', 'run', q(py) + ' run.py',
		'run.py + Python（启动后按项目 README 说明的端口访问）',
		[runPy, py])];
	if (specPath) {
		fns.push(makeFn('build', '打包分发', 'run',
			q(py) + ' -m PyInstaller --noconfirm ' + path.basename(specPath),
			path.basename(specPath) + '（项目自带 PyInstaller 配置）', [specPath, py]));
	}
	const localUrl = 'http://127.0.0.1:8010/';
	fns.push(makeFn('localSite', '本地后台', 'url', localUrl,
		'默认本地端口（按需在配置里改）', []));
	return { tech: 'python', fns };
}

function detectIDE(dir, name, tc, root) {
	const exe = tc.ideExe;
	const codeBat = path.join(dir, 'code-oss/scripts/code.bat');
	const fns = [];
	if (exe) fns.push(makeFn('launch', '启动 IDE', 'run', q(exe),
		'已构建产物（VSCode-win32-*/ 下的可执行文件）', [exe]));
	if (exists(codeBat)) fns.push(makeFn('dev', '源码开发启动', 'run', 'call ' + q(codeBat),
		'code-oss/scripts/code.bat（会先跑 preLaunch 编译）', [codeBat]));
	fns.push(makeFn('build', '打包分发', 'note', '',
		'code-oss/package.json 的 npm run compile + ISCC 打包', [],
		'VS Code 分支打包耗时很长（含 npm install / compile / inno setup），请在项目终端里手动执行 npm run compile'));
	return { tech: 'vscode_fork', fns };
}

/* ---------------------- 通用技术栈探测（新项目也能认出来） ---------------------- */

function readJson(p) { try { return JSON.parse(read(p)); } catch { return null; } }

function detectNode(dir, name, tc, root) {
	const pkgPath = path.join(dir, 'package.json');
	const pkg = readJson(pkgPath) || {};
	const scripts = pkg.scripts || {};
	const npm = tc.npm;
	const fns = [];

	const runKey = ['dev', 'start', 'serve', 'watch'].find(s => scripts[s]);
	if (!npm) {
		fns.push(makeFn('launch', '源码启动', 'note', '', 'package.json 存在，但 PATH 里没有 npm', [],
			'安装 Node.js 后点「重新探测项目结构」即可自动识别'));
	} else if (runKey) {
		fns.push(makeFn('launch', '源码启动', 'run', 'call ' + q(npm) + ' run ' + runKey,
			'package.json 的 scripts.' + runKey, [pkgPath, npm]));
	} else {
		fns.push(makeFn('launch', '源码启动', 'note', '', 'package.json 里没有 dev/start/serve 脚本', [],
			'在 package.json 加 start 脚本后可自动识别'));
	}

	const buildKey = ['build', 'dist', 'package', 'make'].find(s => scripts[s]);
	if (npm && buildKey) {
		fns.push(makeFn('build', '打包分发', 'run', 'call ' + q(npm) + ' run ' + buildKey,
			'package.json 的 scripts.' + buildKey, [pkgPath, npm]));
	}
	if (npm && !isDir(path.join(dir, 'node_modules'))) {
		fns.push(makeFn('install', '安装依赖', 'run', 'call ' + q(npm) + ' install',
			'package.json 存在但尚未安装 node_modules/', [pkgPath, npm]));
	}
	return { tech: 'node', fns, pkg: pkg.name };
}

function detectRust(dir, name, tc, root) {
	const toml = path.join(dir, 'Cargo.toml');
	const cargo = tc.cargo;
	const fns = [];
	if (cargo) {
		fns.push(makeFn('launch', '源码启动', 'run', 'call ' + q(cargo) + ' run',
			'Cargo.toml + cargo（PATH 检测）', [toml, cargo]));
		fns.push(makeFn('build', '打包分发', 'run', 'call ' + q(cargo) + ' build --release',
			'Cargo.toml + cargo', [toml, cargo]));
	} else {
		fns.push(makeFn('launch', '源码启动', 'note', '', 'Cargo.toml 存在，但 PATH 里没有 cargo', [],
			'安装 Rust 工具链后重新探测即可'));
	}
	return { tech: 'rust', fns };
}

function detectGo(dir, name, tc, root) {
	const mod = path.join(dir, 'go.mod');
	const go = tc.go;
	const fns = [];
	if (go) {
		const isMain = exists(path.join(dir, 'main.go'));
		fns.push(makeFn('launch', '源码启动', 'run',
			'call ' + q(go) + (isMain ? ' run .' : ' run ./...'),
			'go.mod' + (isMain ? ' + main.go' : ''), [mod, go]));
		fns.push(makeFn('build', '打包分发', 'run',
			'call ' + q(go) + ' build -o ' + q(name + '.exe') + ' ./...',
			'go.mod（输出 ' + name + '.exe）', [mod, go]));
	} else {
		fns.push(makeFn('launch', '源码启动', 'note', '', 'go.mod 存在，但 PATH 里没有 go', [],
			'安装 Go 后重新探测即可'));
	}
	return { tech: 'go', fns };
}

function detectPythonGeneric(dir, name, tc, root) {
	const py = tc.python;
	const entries = ['main.py', 'app.py', 'run.py', 'manage.py', 'server.py', '__main__.py'];
	const entry = entries.map(f => path.join(dir, f)).find(exists) || null;
	const req = path.join(dir, 'requirements.txt');
	const fns = [];
	if (py && entry) {
		fns.push(makeFn('launch', '源码启动', 'run', q(py) + ' ' + path.basename(entry),
			path.basename(entry) + ' + Python（' + fwd(py) + '）', [entry, py]));
	} else if (!py) {
		fns.push(makeFn('launch', '源码启动', 'note', '', 'Python 项目但 PATH / 常见目录里没有 python', [],
			'安装 Python 后重新探测即可'));
	} else {
		fns.push(makeFn('launch', '源码启动', 'note', '', '未找到 main.py / app.py 之类的入口文件', [],
			'可在「编辑配置」里指定入口文件'));
	}
	if (py && exists(req)) {
		fns.push(makeFn('install', '安装依赖', 'run', q(py) + ' -m pip install -r requirements.txt',
			'requirements.txt', [req, py]));
	}
	const specs = listDir(dir).filter(e => e.isFile() && /\.spec$/i.test(e.name));
	if (py && specs.length) {
		fns.push(makeFn('build', '打包分发', 'run',
			q(py) + ' -m PyInstaller --noconfirm ' + q(specs[0].name),
			specs[0].name + '（项目自带 PyInstaller 配置）', [path.join(dir, specs[0].name), py]));
	} else if (py && exists(path.join(dir, 'setup.py'))) {
		fns.push(makeFn('build', '打包分发', 'note', '', 'setup.py 存在，但未发现 .spec', [],
			'可在终端里执行 python setup.py sdist'));
	}
	return { tech: 'python', fns };
}

function detectStatic(dir, name, tc, root) {
	const index = path.join(dir, 'index.html');
	const py = tc.python;
	const fns = [];
	if (py) {
		fns.push(makeFn('launch', '本地预览', 'run', q(py) + ' -m http.server 8000',
			'index.html + Python 内置静态服务器（http://127.0.0.1:8000/）', [index, py]));
		fns.push(makeFn('localSite', '打开预览', 'url', 'http://127.0.0.1:8000/', '本地静态服务地址', []));
	}
	fns.push(makeFn('web', '打开首页', 'open', fwd(index), 'index.html', [index]));
	return { tech: 'static_site', fns };
}

function detectUnknown(dir, name) {
	return {
		tech: 'unknown',
		fns: [makeFn('launch', '未识别的技术栈', 'note', '',
			'未发现 pubspec.yaml / package.json / Cargo.toml / go.mod / CMakeLists.txt / project.godot / run.py 等特征文件', [],
			'目录已列出；可在「编辑配置」里手动补命令')]
	};
}

/* ------------------------------ 项目扫描主流程 ------------------------------ */

function detectProject(dir, tc, root) {
	const name = path.basename(dir);
	const has = f => exists(path.join(dir, f));
	const hasVSCodeBuild = listDir(dir).some(e => e.isDirectory() && /^VSCode-win32-/i.test(e.name));
	const hasSpec = listDir(dir).some(e => e.isFile() && /\.spec$/i.test(e.name));
	let d;
	if (has('pubspec.yaml')) d = detectFlutter(dir, name, tc, root);
	else if (has('settings.gradle.kts') || (has('gradlew.bat') && has('app/build.gradle.kts'))) d = detectAndroid(dir, name, tc, root);
	else if (has('project.godot')) d = detectGodot(dir, name, tc, root);
	else if (has('run.py') || hasSpec) d = detectPython(dir, name, tc, root);
	else if (has('code-oss/product.json') || hasVSCodeBuild) d = detectIDE(dir, name, tc, root);
	else if (has('CMakeLists.txt')) d = detectCMake(dir, name, tc, root);
	else if (has('package.json')) d = detectNode(dir, name, tc, root);
	else if (has('Cargo.toml')) d = detectRust(dir, name, tc, root);
	else if (has('go.mod')) d = detectGo(dir, name, tc, root);
	else if (has('pyproject.toml') || has('requirements.txt') || has('main.py') || has('app.py')) d = detectPythonGeneric(dir, name, tc, root);
	else if (has('index.html')) d = detectStatic(dir, name, tc, root);
	else d = detectUnknown(dir, name);

	return {
		id: name,
		name: name,
		tech: d.tech,
		platform: d.platform || '',
		path: fwd(dir),
		structure: structureOf(dir),
		functions: [...d.fns, ...siteFn(dir, root)]
	};
}

/* ------------------------------ 服务器 / 后台探查 ------------------------------ */

function collectText(dir, maxFiles) {
	const out = [];
	const exts = /\.(sh|md|txt|py|ps1|json|yaml|yml|xml|html|bat)$/i;
	let count = 0;
	(function walk(d, depth) {
		if (depth > 3 || count >= maxFiles) return;
		for (const e of listDir(d)) {
			if (count >= maxFiles) break;
			const p = path.join(d, e.name);
			if (e.isDirectory()) {
				// 跳过依赖、日志、以及备份/影子副本（里面常是旧域名旧配置，会污染探测结果）
				if (!EXCLUDE_DIRS.has(e.name) &&
					!/^(node_modules|out_|logs|releases?|staging|backups?|archive|old|snapshots?)/i.test(e.name) &&
					!/(swap-staging|pre-domain|pre-cutover|snapshot)/i.test(e.name)) walk(p, depth + 1);
			} else if (exts.test(e.name)) {
				try {
					const st = fs.statSync(p);
					if (st.size <= 400 * 1024) { out.push({ file: p, text: fs.readFileSync(p, 'utf8') }); count++; }
				} catch { /* skip */ }
			}
		}
	})(dir, 0);
	return out;
}

const SITE_DIRS = ['official-site', 'website', 'site', 'www', 'docs-site'];
const DEPLOY_DIRS = ['deploy', 'deployment', 'ops', 'server', 'cloud', 'relay/deploy'];

function mostCommon(arr) {
	const m = new Map();
	for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
	let best = '', n = 0;
	for (const [k, v] of m) if (v > n) { best = k; n = v; }
	return best;
}

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 收集某个项目的部署资料与站点资料（不写死项目名，新项目同样适用）。 */
function collectProjectDocs(dir) {
	const docs = [];
	for (const sub of DEPLOY_DIRS) {
		const d = path.join(dir, sub);
		if (isDir(d)) docs.push(...collectText(d, 500));
	}
	for (const sub of SITE_DIRS) {
		const d = path.join(dir, sub);
		if (!isDir(d)) continue;
		for (const f of ['sitemap.xml', 'robots.txt']) {
			const p = path.join(d, f);
			if (exists(p)) docs.push({ file: p, text: read(p) });
		}
		for (const e of listDir(d)) {
			if (e.isFile() && /\.html?$/i.test(e.name)) docs.push({ file: path.join(d, e.name), text: read(path.join(d, e.name)) });
		}
	}
	return docs;
}

/** 在 deploy/ 下找真实的部署脚本（用于「部署」说明的依据）。 */
function findDeployScript(dir) {
	for (const sub of ['deploy', 'deployment', 'ops', 'server', 'cloud']) {
		const d = path.join(dir, sub);
		if (!isDir(d)) continue;
		for (const e of listDir(d)) {
			if (e.isFile() && /^(deploy|release|publish|install)[\w.-]*\.(sh|py|ps1)$/i.test(e.name)) return fwd(path.join(d, e.name));
		}
		for (const e of listDir(d)) {
			if (!e.isDirectory() || /^(backups?|staging|swap-staging|old)/i.test(e.name)) continue;
			for (const f of listDir(path.join(d, e.name))) {
				if (f.isFile() && /^(deploy|release|publish)[\w.-]*\.(sh|py|ps1)$/i.test(f.name)) return fwd(path.join(d, e.name, f.name));
			}
		}
	}
	return '';
}

function findSshKey(dir) {
	const dirs = [path.join(dir, 'deploy/keys'), path.join(dir, 'deploy'), path.join(dir, '.ssh')];
	for (const c of dirs) {
		if (!isDir(c)) continue;
		for (const e of listDir(c)) {
			if (!e.isFile()) continue;
			if (/(ed25519|id_rsa|id_ecdsa)/i.test(e.name) && !/\.(pub|md|txt|sh|bat|ps1|json|ya?ml)$/i.test(e.name)) return win(path.join(c, e.name));
		}
	}
	return '';
}

/** 从单个项目的资料里推断：服务器、服务名、日志、卡密库、后台/官网地址。 */
function projectInfra(dir, project, root) {
	const docs = collectProjectDocs(dir);
	if (!docs.length) return null;
	const all = docs.map(d => d.text).join('\n');
	const rel = p => fwd(path.relative(root, p));
	const evidenceFor = re => { const hit = docs.find(d => re.test(d.text)); return hit ? rel(hit.file) : ''; };

	// 主机：优先 user@IP，其次 ssh 命令里的域名（排除代码托管），最后 ssh config 的 HostName
	let host = '', user = 'root';
	const ipM = [...all.matchAll(/\b(root|ubuntu|admin|deploy|ecs-user)@((?:\d{1,3}\.){3}\d{1,3})\b/g)];
	const sshM = [...all.matchAll(/\bssh\b[^\n\r;|&]*?\s([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)]
		.filter(m => !/github|gitee|gitlab|bitbucket|codeberg/i.test(m[2]));
	const hnM = all.match(/HostName\s+([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
	if (ipM.length) { user = ipM[0][1]; host = ipM[0][2]; }
	else if (sshM.length) { user = sshM[0][1]; host = sshM[0][2]; }
	else if (hnM) host = hnM[1];

	const services = [...all.matchAll(/systemctl\s+(?:is-active|restart|status|reload|start)\s+([A-Za-z0-9@_.-]+)/g)].map(m => m[1]);
	const service = mostCommon(services);
	const logM = all.match(/(?:\/opt|\/var|\/srv|\/home)[\w./@-]*\.log\b/);
	const logPath = logM ? logM[0] : '';
	const dbM = all.match(/(?:\/opt|\/var|\/srv|\/home)[\w./@-]*\.(?:db|sqlite3?)\b/);
	const dbPath = dbM ? dbM[0] : '';
	const healthM = all.match(/http:\/\/127\.0\.0\.1:\d{2,5}\/[\w./?=&%-]*/);
	const health = healthM ? healthM[0] : '';

	const servers = [];
	if (host) {
		const evSvc = evidenceFor(/systemctl\s+(?:is-active|restart|status)/);
		const fns = [];
		const base = service ? 'systemctl is-active ' + service : 'uptime && df -h';
		fns.push({
			key: 'status', label: '查看状态',
			cmd: health ? base + ' && curl -fsS -m 5 ' + health : base,
			evidence: service ? evSvc : '未在项目脚本里找到服务名，使用通用命令'
		});
		if (logPath) fns.push({ key: 'logs', label: '查看日志', cmd: 'tail -n 50 ' + logPath, evidence: evidenceFor(new RegExp(escRe(logPath))) });
		if (dbPath && /\bcards\b/.test(all)) fns.push({
			key: 'cards', label: '卡密统计',
			cmd: 'sqlite3 -header -column ' + dbPath + ' "SELECT channel,status,COUNT(*) AS n FROM cards GROUP BY channel,status;"',
			evidence: evidenceFor(new RegExp(escRe(dbPath)))
		});
		if (service) fns.push({ key: 'restart', label: '重启服务', cmd: 'systemctl restart ' + service + ' && systemctl is-active ' + service, evidence: evSvc });
		const ds = findDeployScript(dir);
		const deployScript = ds ? rel(ds) : evidenceFor(/deploy_prefix\.sh|deploy\.sh|deploy\.py|release\.sh|publish\.sh/);
		if (deployScript) fns.push({
			key: 'deploy', label: '部署', type: 'note',
			text: '部署脚本在服务器端执行；请先在 SSH 终端里确认备份与 staged 文件，不使用本地一键部署。',
			evidence: deployScript
		});
		servers.push({
			id: project.id,
			name: project.name + ' 服务器',
			host, user, port: 22, type: 'ssh',
			key: findSshKey(dir),
			evidence: [evidenceFor(/\b(root|ubuntu|admin|deploy|ecs-user)@/), evSvc].filter(Boolean).join(' + '),
			notes: '依据项目内 deploy/ 与站点资料自动探查；服务名、日志与数据库路径均取自真实脚本。',
			functions: fns
		});
	}

	const sites = [];
	const seen = new Set();
	const addSite = (id, name, url, note) => {
		if (!url || seen.has(url)) return;
		seen.add(url);
		sites.push({ id: project.id + '-' + id, name, url, note });
	};
	const admin = mostCommon([...all.matchAll(/https?:\/\/[A-Za-z0-9.-]+\/admin\/?/g)].map(m => m[0].replace(/\/?$/, '/')));
	if (admin) addSite('admin', project.name + ' · 管理后台', admin, '依据：' + evidenceFor(/\/admin\/?/));
	for (const d of docs) {
		const m = d.text.match(/<loc>\s*([^<]+?)\s*<\/loc>/);
		if (m) { addSite('site', project.name + ' 官网', m[1].trim(), '依据：' + rel(d.file)); break; }
	}
	const shop = all.match(/https?:\/\/[^\s"'<>]*liebiao[^\s"'<>]*/);
	if (shop) addSite('shop', project.name + ' 发卡平台', shop[0], '依据：' + evidenceFor(/liebiao/));
	const appUrl = all.match(/https?:\/\/app\.[A-Za-z0-9.-]+\//);
	if (appUrl) addSite('app', project.name + ' 分发 / License API', appUrl[0], '依据：' + evidenceFor(/app\./));

	return { servers, sites };
}

function detectInfra(root, projects, tc) {
	const servers = [], admin_sites = [];
	const seenHosts = new Set(), seenUrls = new Set();
	for (const p of projects || []) {
		const dir = path.join(root, p.id);
		if (!isDir(dir)) continue;
		let info = null;
		try { info = projectInfra(dir, p, root); } catch { info = null; }
		if (!info) continue;
		for (const s of info.servers) {
			const hk = s.user + '@' + s.host;
			if (seenHosts.has(hk)) continue;
			seenHosts.add(hk);
			servers.push(s);
		}
		for (const site of info.sites) {
			if (seenUrls.has(site.url)) continue;
			seenUrls.add(site.url);
			admin_sites.push(site);
		}
	}
	return { servers, admin_sites, toolchain: tc || detectToolchain(root) };
}

/* ------------------------------ 对外入口 ------------------------------ */

function scan(root) {
	root = fwd(root || process.cwd()).replace(/\/$/, '');
	const tc = detectToolchain(root);
	const projects = [];
	for (const e of listDir(root)) {
		if (!e.isDirectory() || EXCLUDE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
		const dir = path.join(root, e.name);
		// 空目录不算项目，避免噪音
		if (!listDir(dir).length) continue;
		let p = null;
		try { p = detectProject(dir, tc, root); } catch { p = null; }
		if (p) projects.push(p);
	}
	projects.sort((a, b) => a.id.localeCompare(b.id));
	const infra = detectInfra(root, projects, tc);
	return {
		projects_root: root,
		scanner_version: SCANNER_VERSION,
		scanned_at: new Date().toISOString(),
		toolchain: infra.toolchain,
		projects,
		servers: infra.servers,
		admin_sites: infra.admin_sites
	};
}

/**
 * 增量合并：把新探测到的项目并进现有配置，保留用户对已有项目的命令改动。
 * - 新目录 → 追加
 * - 未知技术栈升级为已识别 → 替换该项目的探测结果
 * - 目录已删除 → 移除
 * 服务器/后台以人工已有配置优先，避免自动扫描覆盖手填的主机。
 */
function merge(prev, fresh) {
	const byId = new Map(((prev && prev.projects) || []).map(p => [p.id, p]));
	const added = [], upgraded = [], removed = [];
	for (const p of fresh.projects) {
		const old = byId.get(p.id);
		if (!old) { byId.set(p.id, p); added.push(p); }
		else if (old.tech === 'unknown' && p.tech !== 'unknown') { byId.set(p.id, p); upgraded.push(p); }
	}
	for (const p of [...byId.values()]) {
		if (!exists(p.path)) { byId.delete(p.id); removed.push(p); }
	}
	const union = (a, b) => {
		const out = [...(a || [])];
		const ids = new Set(out.map(x => x.id));
		for (const x of b || []) if (!ids.has(x.id)) out.push(x);
		return out;
	};
	return {
		config: {
			...fresh,
			projects: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
			servers: union(prev && prev.servers, fresh.servers),
			admin_sites: union(prev && prev.admin_sites, fresh.admin_sites)
		},
		added, upgraded, removed
	};
}

module.exports = { scan, merge, detectToolchain, detectInfra, SCANNER_VERSION };

if (require.main === module) {
	const root = fwd(process.argv[2] || process.cwd());
	const out = process.argv[3];
	const data = scan(root);
	const text = JSON.stringify(data, null, 2);
	if (out) { fs.writeFileSync(out, text, 'utf8'); console.log('WROTE ' + out); }
	else console.log(text);
}
