window.__ModuleLoader__.load({ id: "dsh-pocket", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/client/api.ts
/** Kept in step with API_PREFIX in the host half. */
const PREFIX = "/pocket/api";
/** Raised when a route answers with a non-2xx status. */
var ApiFailure = class extends Error {};
async function call(path, init) {
	const response = await fetch(path, {
		...init,
		credentials: "same-origin"
	});
	if (!response.ok) throw new ApiFailure(`HTTP ${String(response.status)}`);
	return await response.json();
}
/**
* Build the API client.
* @returns The client.
*/
function createApi() {
	return {
		status: () => call(`${PREFIX}/status`),
		link: async () => {
			return (await call(`${PREFIX}/link`, { method: "POST" })).authUrl;
		},
		unlink: () => call(`${PREFIX}/unlink`, { method: "POST" }),
		rotatePairing: async () => {
			await call(`${PREFIX}/pairing/rotate`, { method: "POST" });
		}
	};
}

//#endregion
//#region src/client/PocketSection.tsx
const card = {
	border: "1px solid var(--dsh-border, #dee3ea)",
	borderRadius: "var(--dsh-radius-md, 8px)",
	padding: "18px 20px",
	marginBottom: 14,
	background: "var(--dsh-surface, transparent)"
};
const label = {
	fontSize: 12,
	letterSpacing: "0.06em",
	textTransform: "uppercase",
	opacity: .6,
	marginBottom: 6
};
const button = {
	font: "inherit",
	padding: "8px 16px",
	borderRadius: "var(--dsh-radius-sm, 6px)",
	border: "1px solid var(--dsh-border, #dee3ea)",
	background: "var(--dsh-accent, #4D6BFE)",
	color: "#fff",
	cursor: "pointer"
};
const secondaryButton = {
	...button,
	background: "transparent",
	color: "inherit"
};
/**
* Render the pocket settings page.
* @param props - Injected host services and translator.
* @returns The page.
*/
function PocketSection(props) {
	const { api, t, version } = props;
	const [status, setStatus] = (0, react.useState)(void 0);
	const [busy, setBusy] = (0, react.useState)(false);
	const [failure, setFailure] = (0, react.useState)(void 0);
	const refresh = (0, react.useCallback)(() => {
		api.status().then(setStatus).catch((error) => {
			setFailure(error instanceof Error ? error.message : String(error));
		});
	}, [api]);
	(0, react.useEffect)(refresh, [refresh]);
	(0, react.useEffect)(() => {
		if (status?.linking !== true) return void 0;
		const timer = setInterval(refresh, 2e3);
		return () => {
			clearInterval(timer);
		};
	}, [status?.linking, refresh]);
	const onLink = (0, react.useCallback)(() => {
		setBusy(true);
		setFailure(void 0);
		api.link().then((authUrl) => {
			window.open(authUrl, "_blank", "noopener,noreferrer");
			refresh();
		}).catch((error) => {
			setFailure(error instanceof Error ? error.message : String(error));
		}).finally(() => {
			setBusy(false);
		});
	}, [api, refresh]);
	const onUnlink = (0, react.useCallback)(() => {
		setBusy(true);
		api.unlink().then(setStatus).catch((error) => {
			setFailure(error instanceof Error ? error.message : String(error));
		}).finally(() => {
			setBusy(false);
		});
	}, [api]);
	const connectionText = (state) => {
		if (state.connection === "online") return t("stateOnline", { viewers: state.viewers });
		if (state.connection === "connecting") return t("stateConnecting");
		return t("stateOffline");
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
			style: {
				fontSize: 18,
				margin: "0 0 6px"
			},
			children: t("title")
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			style: {
				margin: "0 0 18px",
				maxWidth: "60ch",
				opacity: .8,
				lineHeight: 1.7
			},
			children: t("intro")
		}),
		status?.enabled === false && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: card,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: label,
				children: t("disabledTitle")
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: {
					margin: 0,
					lineHeight: 1.7
				},
				children: t("disabledBody")
			})]
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: card,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: label,
					children: status?.linked === true ? t("stateLinked", { name: status.deviceName ?? "" }) : t("stateUnlinked")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: {
						margin: "0 0 14px",
						opacity: .75
					},
					children: status === void 0 ? "…" : connectionText(status)
				}),
				status?.linked === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					style: secondaryButton,
					disabled: busy,
					onClick: onUnlink,
					children: t("unlink")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					style: button,
					disabled: busy || status?.linking === true,
					onClick: onLink,
					children: status?.linking === true ? t("waiting") : t("link")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: {
						margin: "10px 0 0",
						fontSize: 13,
						opacity: .65,
						lineHeight: 1.65
					},
					children: status?.linking === true ? t("waitingHint") : t("linkHint")
				})] })
			]
		}),
		failure !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			style: { color: "var(--dsh-danger, #B93B2E)" },
			children: t("failed", { detail: failure })
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
			style: {
				fontSize: 12,
				opacity: .5,
				marginTop: 20
			},
			children: ["dsh-pocket ", version]
		})
	] });
}

//#endregion
//#region src/client/locales.ts
/** UI strings. Keys are shared by both dictionaries; a missing key falls back to the key itself. */
const en = {
	nav: "Pocket",
	title: "Use this agent from your phone",
	intro: "Link this machine to an A2H Market account, then open dsh-pocket.a2hmarket.ai on your phone to watch this agent work, answer its approval requests, and stop a turn that is going wrong.",
	stateUnlinked: "Not linked",
	stateLinked: "Linked as {name}",
	stateOffline: "Not connected to the relay",
	stateConnecting: "Connecting…",
	stateOnline: "Connected · {viewers} phone(s) attached",
	link: "Link an A2H account",
	waiting: "Waiting for you to confirm…",
	waitingHint: "Confirm in the browser tab that just opened. This page updates by itself once you do.",
	unlink: "Unlink this machine",
	linkHint: "A browser tab will open for you to approve.",
	disabledTitle: "Turned off",
	disabledBody: "Pocket is switched off in this profile, so nothing is connected. Turn it on in cordis.patch.yml to use it.",
	failed: "Something went wrong: {detail}"
};
const zh = {
	nav: "手机接管",
	title: "在手机上接手这个 agent",
	intro: "把这台机器连到 A2H Market 账号，然后在手机上打开 dsh-pocket.a2hmarket.ai，就能看它干活、回复它的审批请求、叫停跑偏的任务。",
	stateUnlinked: "未连接账号",
	stateLinked: "已连接为 {name}",
	stateOffline: "未连上中继",
	stateConnecting: "连接中…",
	stateOnline: "已连接 · {viewers} 台手机在看",
	link: "连接 A2H 账号",
	waiting: "等你确认…",
	waitingHint: "在刚打开的浏览器标签页里点确认，这里会自己变。",
	unlink: "解除本机连接",
	linkHint: "会打开一个浏览器标签页让你确认授权。",
	disabledTitle: "未启用",
	disabledBody: "这个 profile 里 pocket 是关着的，不会连任何东西。要用就在 cordis.patch.yml 里打开。",
	failed: "出错了：{detail}"
};

//#endregion
//#region src/client/index.ts
/** The locale namespace this plugin owns. */
const NS = "settings.pocket";
/** Plugin version, shown in the page footer. Bump it together with package.json. */
const VERSION = "0.1.0";
/** Browser-side services required. */
const inject = ["slots", "locale"];
/**
* Mount the pocket page.
* @param ctx - Browser plugin context.
*/
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "pocket: dictionaries");
	const t = ctx.locale.bind(NS);
	const api = createApi();
	const injected = () => ({
		api,
		t,
		version: VERSION
	});
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "pocket",
		order: 45,
		label: () => t("nav"),
		locale: NS,
		inject: injected
	}, PocketSection));
}

//#endregion
exports.NS = NS;
exports.apply = apply;
exports.inject = inject;
return module.exports; } });