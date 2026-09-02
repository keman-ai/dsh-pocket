import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";

//#region src/credentials.ts
/** File name inside the profile directory. */
const FILE$1 = "pocket-credentials.json";
/**
* Resolve ctx.baseUrl to a local directory. It may be a file:// URL or already a path.
* @param baseUrl - The config-tree anchor.
* @returns Absolute profile directory, or undefined when it cannot be resolved.
*/
function profileDirOf(baseUrl) {
	if (baseUrl === void 0 || baseUrl === "") return void 0;
	try {
		return baseUrl.startsWith("file:") ? fileURLToPath(baseUrl) : baseUrl;
	} catch {
		return;
	}
}
/**
* Absolute path of the credentials file for a profile.
* @param profileDir - The profile directory.
* @returns Absolute file path.
*/
function credentialsPath(profileDir) {
	return join(profileDir, FILE$1);
}
/**
* Read this machine's credentials.
* @param profileDir - The profile directory.
* @returns The stored credentials, or undefined when this machine is not linked yet.
*/
function readCredentials(profileDir) {
	const path = credentialsPath(profileDir);
	if (!existsSync(path)) return void 0;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed.deviceId !== "string" || typeof parsed.token !== "string") return void 0;
		return {
			deviceId: parsed.deviceId,
			token: parsed.token,
			deviceName: typeof parsed.deviceName === "string" ? parsed.deviceName : parsed.deviceId,
			authorisedAt: typeof parsed.authorisedAt === "string" ? parsed.authorisedAt : ""
		};
	} catch {
		return;
	}
}
/**
* Write credentials so that a crash mid-write cannot leave a half-file.
*
* Write to a sibling temp file, fsync it, then rename over the target: rename is atomic
* within a directory, so a reader sees either the old file or the new one. Then chmod
* 0600 — the token authorises a phone to drive this machine's agent, so it must not be
* world-readable on a shared box.
*
* @param profileDir - The profile directory.
* @param credentials - What to persist.
*/
function writeCredentials(profileDir, credentials) {
	const path = credentialsPath(profileDir);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	const payload = `${JSON.stringify(credentials, null, 2)}\n`;
	const fd = openSync(temp, "w", 384);
	try {
		writeSync(fd, payload);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, path);
	try {
		chmodSync(path, 384);
	} catch {}
}
/**
* Forget this machine's credentials.
*
* Unlinking is the whole job: the relay side of the revocation is a separate call, and
* doing it here as well would tie "stop using the token locally" to a network round trip
* that can fail.
*
* @param profileDir - The profile directory.
*/
function clearCredentials(profileDir) {
	const path = credentialsPath(profileDir);
	if (!existsSync(path)) return;
	unlinkSync(path);
}

//#endregion
//#region src/link.ts
/** How long to wait for the person to confirm before giving up. */
const AUTHORISE_TIMEOUT_MS = 300 * 1e3;
/** Gap between polls. Short enough to feel instant, long enough not to hammer. */
const POLL_EVERY_MS = 3e3;
/** Raised when linking fails for a reason worth showing the user. */
var LinkFailure = class extends Error {};
/** Device secrets carry this prefix; an access token does not. */
const SECRET_PREFIX = "pks_";
/**
* Whether stored credentials still hold an access token rather than a device secret.
*
* Machines linked before device secrets existed have a PAT on disk. That is exactly the
* credential needed to obtain a device secret, so they can upgrade themselves instead of
* asking the person to authorise again — and the sooner they do, the sooner that PAT
* stops sitting in a file the agent can read.
*
* @param credentials - What is on disk.
* @returns true when a migration is due.
*/
function needsSecretUpgrade(credentials) {
	return !credentials.token.startsWith(SECRET_PREFIX);
}
/**
* Trade a stored access token for a device secret, keeping the same device.
*
* @param endpoints - Where the relay is.
* @param credentials - Existing credentials holding an access token.
* @returns Credentials holding a device secret.
*/
async function upgradeToDeviceSecret(endpoints, credentials) {
	return registerDevice(endpoints.relayOrigin, credentials.token, credentials.deviceName);
}
/**
* One in-flight authorisation per dsh process.
*
* A single slot rather than a map: two browser tabs authorising the same machine has no
* meaning, and a second start should supersede the first rather than leave both live.
* Memory-only — an unfinished authorisation does not survive a restart, and should not.
*/
let pending;
/**
* Begin an authorisation and poll until it completes.
*
* @param endpoints - Where to send the browser and where to poll.
* @param onDone - Called once with the outcome. Never called if the attempt is superseded.
* @returns The URL to open in the browser.
*/
function beginLink(endpoints, onDone) {
	cancelLink();
	const code = `POCKET-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
	const abort = new AbortController();
	pending = {
		code,
		abort
	};
	poll(endpoints, code, abort.signal).then(async (token) => {
		const credentials = await registerDevice(endpoints.relayOrigin, token);
		if (!abort.signal.aborted) onDone({
			ok: true,
			credentials
		});
	}).catch((error) => {
		if (abort.signal.aborted) return;
		onDone({
			ok: false,
			detail: error instanceof LinkFailure ? error.message : "the authorisation could not be completed"
		});
	}).finally(() => {
		if (pending?.code === code) pending = void 0;
	});
	return { authUrl: `${endpoints.accountOrigin}/authcode?code=${encodeURIComponent(code)}` };
}
/** Whether an authorisation is waiting for the person to confirm. */
function isLinking() {
	return pending !== void 0;
}
/** Abandon any in-flight authorisation. */
function cancelLink() {
	pending?.abort.abort();
	pending = void 0;
}
/**
* Poll the public read endpoint until the grant appears.
*
* @param endpoints - Where to poll.
* @param code - The code shown to the account site.
* @param signal - Aborted when the attempt is superseded or cancelled.
* @returns The personal access token.
*/
async function poll(endpoints, code, signal) {
	const url = `${endpoints.userOrigin}/api/v1/public/user/agent/auth?code=${encodeURIComponent(code)}`;
	const deadline = Date.now() + AUTHORISE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (signal.aborted) throw new LinkFailure("cancelled");
		const token = await readGrant(url, signal);
		if (token !== void 0) return token;
		await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
	}
	throw new LinkFailure("the authorisation timed out; start again from Settings");
}
/**
* One poll.
* @param url - The public read endpoint.
* @param signal - Abort signal.
* @returns The token, or undefined while the person has not confirmed yet.
*/
async function readGrant(url, signal) {
	let response;
	try {
		response = await fetch(url, { signal });
	} catch {
		return;
	}
	if (!response.ok) return void 0;
	const token = (await response.json().catch(() => ({}))).data?.patToken;
	return typeof token === "string" && token !== "" ? token : void 0;
}
/**
* Register this machine with the relay and obtain its own credential.
*
* 🔴 The access token is used for exactly this call and then dropped. What gets stored
* is the device secret the relay issues here — see DeviceCredentials for why.
*
* @param relayOrigin - Relay origin.
* @param token - The personal access token just obtained; not retained.
* @returns Credentials for this machine.
*/
async function registerDevice(relayOrigin, token, name$1) {
	const deviceName = name$1 ?? hostname();
	const response = await fetch(`${relayOrigin}/api/v1/pocket/devices`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`
		},
		body: JSON.stringify({ deviceName })
	});
	if (!response.ok) throw new LinkFailure(`the relay refused to register this machine (HTTP ${String(response.status)})`);
	const body = await response.json();
	const deviceId = body.data?.deviceId;
	const deviceSecret = body.data?.deviceSecret;
	if (typeof deviceId !== "string" || deviceId === "") throw new LinkFailure("the relay returned no device id");
	if (typeof deviceSecret !== "string" || deviceSecret === "") throw new LinkFailure("the relay issued no device secret; it may be running an older build");
	return {
		deviceId,
		token: deviceSecret,
		deviceName,
		authorisedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}

//#endregion
//#region src/approvals.ts
/** How long a phone has to answer before the question goes back to the local chain. */
const PHONE_TIMEOUT_MS$1 = 9e4;
/**
* Routes approval questions to whoever is watching, and answers from their taps.
*/
var PhoneApprovals = class {
	pending = /* @__PURE__ */ new Map();
	counter = 0;
	deps;
	constructor(deps) {
		this.deps = deps;
	}
	/**
	* The answerer to register on `approval/request`.
	*
	* @param req - The pending decision.
	* @param next - Delegates to the rest of the chain.
	* @returns The outcome.
	*/
	async answer(req, next) {
		if (this.deps.viewers() === 0) return next();
		const requestId = `req_${String(++this.counter)}_${crypto.randomUUID().slice(0, 8)}`;
		const expiresAt = new Date(Date.now() + PHONE_TIMEOUT_MS$1).toISOString();
		if (!this.deps.ask({
			sessionId: req.agent.id,
			requestId,
			tool: req.toolName,
			argsSummary: "",
			expiresAt,
			...req.callId === void 0 ? {} : { callId: req.callId },
			...req.reason === void 0 ? {} : { reason: req.reason }
		})) return next();
		const decision = await this.waitForPhone(requestId, req.signal);
		if (decision === void 0) {
			this.deps.log.debug("[pocket] no answer from a phone for %s, handing back to dsh", req.toolName);
			return next();
		}
		this.deps.log.info("[pocket] %s was %s from a phone", req.toolName, decision === "allow" ? "allowed" : "refused");
		return decision === "allow" ? "allowed-once" : "rejected";
	}
	/**
	* Apply an answer that came back from a phone.
	*
	* @param requestId - The id from the question.
	* @param decision - What the person tapped.
	*/
	resolve(requestId, decision) {
		const waiting = this.pending.get(requestId);
		if (waiting === void 0) {
			this.deps.log.debug("[pocket] a late approval answer was discarded");
			return;
		}
		waiting.settle(decision);
	}
	/**
	* Abandon every pending question. Called when the plugin unloads.
	*
	* 🔴 Each one is settled, not just dropped. An answerer's promise that never resolves
	* holds the approval waterfall open forever, so unloading pocket mid-question would
	* freeze the agent that asked — the exact failure this whole module is written to
	* avoid. Settling with no decision hands each question back to the local chain.
	*/
	dispose() {
		for (const waiting of [...this.pending.values()]) {
			clearTimeout(waiting.timer);
			waiting.settle(void 0);
		}
		this.pending.clear();
	}
	waitForPhone(requestId, signal) {
		return new Promise((resolve) => {
			const finish = (value) => {
				const waiting = this.pending.get(requestId);
				if (waiting !== void 0) {
					clearTimeout(waiting.timer);
					this.pending.delete(requestId);
				}
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const onAbort = () => {
				finish(void 0);
			};
			const timer = setTimeout(() => {
				finish(void 0);
			}, PHONE_TIMEOUT_MS$1);
			timer.unref?.();
			this.pending.set(requestId, {
				settle: finish,
				timer
			});
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
};

//#endregion
//#region src/models.ts
/** The session domain, or undefined where it is not composed. */
function sessions(ctx) {
	return ctx.get("sessionController");
}
/** The settings domain. */
function settings(ctx) {
	return ctx.get("settingsController");
}
/** The workspace domain. */
function workspaces(ctx) {
	return ctx.get("workspaceController");
}
/**
* Run one controller call, turning a refusal into `undefined`.
*
* @param ctx - Host plugin context, for logging.
* @param what - What was being attempted, for the log.
* @param run - The call.
* @returns Its value, or undefined when it failed.
*/
async function attempt(ctx, what, run) {
	try {
		return await run();
	} catch (error) {
		lastFailure = `${what}: ${error instanceof Error ? error.message : String(error)}`;
		ctx.logger.warn("[pocket] %s", lastFailure);
		return;
	}
}
/**
* Why the last controller call failed.
*
* 🔴 Kept so the reason can reach the phone. Every reader here turns a failure into an
* empty result, which on a phone looks like "the feature is just blank" — the single
* most expensive failure mode in this codebase, and the one that hid an entire broken
* RPC path for a whole release. The message is for a person; it never carries a path.
*/
let lastFailure;
/** The last failure, and clears it. */
function takeFailure() {
	const failure = lastFailure;
	lastFailure = void 0;
	return failure;
}
/**
* The model catalog.
*
* @param ctx - Host plugin context.
* @param sessionId - Which session the phone is choosing for.
* @returns The catalog, or undefined when dsh could not answer.
*/
async function readCatalog(ctx, sessionId) {
	const controller = sessions(ctx);
	if (controller === void 0) return void 0;
	const catalog = await attempt(ctx, "model catalog", async () => controller.modelCatalog());
	if (catalog === void 0) return void 0;
	const models = flatten(catalog);
	const first = models[0];
	return {
		sessionId,
		models,
		current: catalog.default ?? (first === void 0 ? {
			provider: "",
			model: ""
		} : {
			provider: first.provider,
			model: first.model
		})
	};
}
/** Provider groups flattened into one pickable list. */
function flatten(catalog) {
	const out = [];
	for (const provider of catalog.groups ?? []) for (const model of provider.models ?? []) out.push({
		provider: provider.id,
		model: model.id,
		label: `${provider.name} · ${model.name}`
	});
	return out;
}
/**
* Switch a session's model.
*
* @param ctx - Host plugin context.
* @param sessionId - Session to change.
* @param provider - Provider route.
* @param model - Model id.
* @returns Whether dsh accepted it.
*/
async function selectModel(ctx, sessionId, provider, model) {
	const controller = sessions(ctx);
	if (controller === void 0) return false;
	return await attempt(ctx, "model selection", async () => controller.selectModel({
		sessionId,
		provider,
		model
	})) !== void 0;
}

//#endregion
//#region src/actions.ts
/** Longest message accepted from a phone, matching the contract's `session.send`. */
const TEXT_LIMIT = 8e3;
/**
* Run one action from a phone.
*
* @param ctx - Host plugin context, for the agent registry and logging.
* @param action - The action, already validated as one of the allowed kinds.
* @param onRename - Applies a new device name locally.
* @returns What happened, so the caller can log one line.
*/
function runAction(ctx, action, onRename) {
	switch (action.t) {
		case "session.open": return "ignored";
		case "session.send": return "ignored";
		case "turn.stop": {
			const controller = sessions(ctx);
			if (controller === void 0) return "ignored";
			try {
				controller.cancel({ sessionId: action.sessionId });
				return "done";
			} catch {
				return "ignored";
			}
		}
		case "device.rename":
			onRename(action.name.slice(0, 40));
			return "done";
		case "approval.respond": return "ignored";
		default: return "ignored";
	}
}
/**
* Speak into a session, with or without a photo.
*
* 🔴 This goes through `sessionController.prompt`, not `agent.followup`, and the
* difference is not cosmetic:
*
*   · **it resumes a session whose agent is not live.** `ctx.agents.get()` only knows
*     what is currently loaded, so the old path could answer nothing but "this session is
*     gone" for anything the person had not already opened on the computer — and after a
*     restart that is every session they own;
*   · **it takes image bytes directly** and promotes them to durable attachments itself,
*     with the deployment's own size and count limits applied. Doing that by hand meant
*     duplicating rules that live in the host.
*
* @param ctx - Host plugin context.
* @param sessionId - Which session to speak into.
* @param text - What the person typed; may be empty when sending only a photo.
* @param images - Photos, base64 as they arrived.
* @returns undefined on success, or a reason to show the person.
*/
async function speak(ctx, sessionId, text, images = []) {
	const controller = sessions(ctx);
	if (controller === void 0) return "这台电脑上的 dsh 没有会话控制器";
	const trimmed = text.slice(0, TEXT_LIMIT);
	if (trimmed.trim() === "" && images.length === 0) return void 0;
	const content = [];
	if (trimmed !== "") content.push({
		type: "text",
		text: trimmed
	});
	for (const image of images) content.push({
		type: "image",
		mediaType: image.mediaType,
		data: image.data
	});
	return await attempt(ctx, "prompt", async () => controller.prompt({
		requestId: crypto.randomUUID(),
		sessionId,
		mode: "queue",
		content
	}, AbortSignal.timeout(6e4))) === void 0 ? "发送失败，电脑那边没接受" : void 0;
}

//#endregion
//#region src/questions.ts
/** How long a phone has to answer before the question goes back to the local chain. */
const PHONE_TIMEOUT_MS = 12e4;
/** Routes the agent's questions to whoever is watching, and answers from their taps. */
var PhoneQuestions = class {
	pending = /* @__PURE__ */ new Map();
	counter = 0;
	/** 经过这个答复者的提问总数，含立刻转交的。 */
	seen = 0;
	deps;
	constructor(deps) {
		this.deps = deps;
	}
	/**
	* The answerer to register on `user-questions/request`.
	*
	* @param request - The pending question.
	* @param next - Delegates to the rest of the chain.
	* @returns The answer.
	*/
	async answer(request, next) {
		this.seen += 1;
		if (this.deps.viewers() === 0) return next();
		this.counter += 1;
		const id = `q${String(this.counter)}`;
		this.deps.ask({
			rpcId: id,
			sessionId: request.agent?.id ?? "",
			questions: request.questions.map((q) => ({
				id: q.id,
				question: q.question,
				...q.detail === void 0 ? {} : { detail: q.detail },
				...q.header === void 0 ? {} : { header: q.header },
				...q.multiSelect === void 0 ? {} : { multiSelect: q.multiSelect },
				...q.options === void 0 ? {} : { options: q.options.map((o) => ({
					label: o.label,
					...o.description === void 0 ? {} : { description: o.description }
				})) }
			}))
		});
		const answer = await new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.deps.resolved(id);
				this.deps.log.debug("[pocket] nobody answered a question in time; handing it back");
				resolve(void 0);
			}, PHONE_TIMEOUT_MS);
			request.signal?.addEventListener("abort", () => {
				this.pending.delete(id);
				clearTimeout(timer);
				this.deps.resolved(id);
				resolve(void 0);
			}, { once: true });
			this.pending.set(id, {
				settle: resolve,
				timer
			});
		});
		if (answer === void 0) return next();
		return answer;
	}
	/**
	* A phone answered.
	*
	* @param rpcId - The id sent with the question.
	* @param answers - One entry per question.
	*/
	resolve(rpcId, answers) {
		const waiting = this.pending.get(rpcId);
		if (waiting === void 0) return;
		this.pending.delete(rpcId);
		clearTimeout(waiting.timer);
		this.deps.resolved(rpcId);
		waiting.settle({ answers });
	}
	/** Hand every waiting question back to the chain. */
	releaseAll() {
		for (const [id, waiting] of this.pending) {
			clearTimeout(waiting.timer);
			this.deps.resolved(id);
			waiting.settle(void 0);
		}
		this.pending.clear();
	}
};

//#endregion
//#region src/sessions.ts
/** How long text deltas accumulate before one frame goes out. */
const COALESCE_MS = 200;
/** Longest title derived from a first message. */
const TITLE_LIMIT = 48;
/** Longest tool-argument summary put on the wire. Truncated here; the relay never truncates. */
const ARGS_LIMIT = 2e3;
/** Event kinds a phone is allowed to see. */
const FORWARDED = new Set([
	"turn/start",
	"turn/end",
	"user/message",
	"assistant/chunk",
	"tool/call",
	"tool/result",
	"todo/write"
]);
/**
* Whether a user-role message is context dsh injected rather than something the person
* typed, and if so what to call the folded block on the phone.
*
* 🔴 Every user-role log entry arrives as `role: 'user'` — the runtime-context snapshot and
* the skill catalog included. Forwarding them as plain user bubbles is what buried the
* actual prompt under two screens of policy text and a skill list (the phone showed all
* three as equal messages). The desktop UI folds them away by `source.kind`; this does the
* same classification so the phone can too. The returned `note` is a stable token, not a
* label — the phone owns the wording, because this package ships in English and the phone
* is Chinese.
*
* @param source - The message's source, absent on older logs and plain typed messages.
* @returns undefined for a real user message; otherwise the phone-facing context tag.
*/
function contextTag(source) {
	const kind = source?.kind;
	if (kind === void 0 || kind === "user") return void 0;
	if (kind === "skill-catalog") return {
		role: "context",
		note: "skills"
	};
	if (source?.form === "snapshot") return {
		role: "context",
		note: "runtime"
	};
	return {
		role: "context",
		note: "context"
	};
}
/** Joins the text of a message's content blocks; non-text blocks are ignored. */
function textOf(content) {
	if (content === void 0) return "";
	return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/**
* What a tool result should say on a phone.
*
* 🔴 A failed call carries its reason in `error`, not in the message content — which is
* often empty for a failure. Reading only the content gave the phone a bare "失败" with
* nothing after it, and a person looking at that cannot tell a bad argument from a
* crashed command (2026-09-01: a model kept passing `todos` as a string, and the screen
* said only "失败" three times in a row).
*/
function resultSummary(event) {
	const text = textOf(event.data.message.content);
	const failure = event.data.error;
	if (failure === void 0) return clip(text, ARGS_LIMIT);
	const reason = [failure.name, failure.code].filter((part) => part !== "" && part !== void 0).join(" · ");
	return clip(text === "" ? reason : `${reason}：${text}`, ARGS_LIMIT);
}
/** Names a session by its working directory's last segment, when nothing better is known. */
function folderOf(cwd) {
	if (cwd === void 0 || cwd === "") return "";
	const parts = cwd.split("/").filter((part) => part !== "");
	return parts[parts.length - 1] ?? "";
}
/** Cuts a string to a limit without leaving a dangling surrogate pair. */
function clip(text, limit) {
	if (text.length <= limit) return text;
	return `${Array.from(text).slice(0, limit).join("")}…`;
}
/**
* Project a batch of already-recorded events, for history.
*
* Deliberately separate from the live path and free of its machinery: no timers, no
* mutation of live session state. History is a finished thing — coalescing it means
* joining adjacent deltas right here, and a running turn's `running` flag must not be
* disturbed by reading its past.
*
* What it shares with the live path is the projection itself, so the same conversation
* renders the same way whether it arrived seconds ago or last week.
*
* @param events - Raw log events, oldest first.
* @returns Phone-shaped events, oldest first.
*/
function projectHistory(events) {
	const out = [];
	const push = (kind, at, payload) => {
		const last = out[out.length - 1];
		if ((kind === "assistant/chunk" || kind === "assistant/reasoning") && last?.kind === kind) {
			out[out.length - 1] = {
				...last,
				payload: { text: String(last.payload["text"] ?? "") + String(payload["text"] ?? "") }
			};
			return;
		}
		out.push({
			kind,
			at: new Date(at).toISOString(),
			payload
		});
	};
	for (const event of events) switch (event.type) {
		case "user/message":
			push("user/message", event.time, {
				text: textOf(event.data.content),
				...contextTag(event.data.source) ?? {}
			});
			break;
		case "assistant/chunk": {
			const chunk = event.data.chunk;
			if (chunk.type === "text-delta") push("assistant/chunk", event.time, { text: chunk.text });
			else if (chunk.type === "reasoning-delta") push("assistant/reasoning", event.time, { text: chunk.text ?? "" });
			break;
		}
		case "tool/call":
			push("tool/call", event.time, {
				tool: event.data.name,
				argsSummary: clip(event.data.arguments, ARGS_LIMIT)
			});
			break;
		case "tool/result":
			push("tool/result", event.time, {
				tool: "",
				ok: event.data.error === void 0,
				summary: resultSummary(event)
			});
			break;
		case "todo/write":
			for (let i = out.length - 1; i >= 0; i -= 1) if (out[i]?.kind === "todo/write") {
				out.splice(i, 1);
				break;
			}
			push("todo/write", event.time, { todos: event.data.todos });
			break;
		default: break;
	}
	return out;
}
/**
* Turns the session log into phone-shaped events and keeps the session index.
*
* One instance per plugin load. It holds no history: an event is projected, handed to
* the sink, and forgotten. A phone that connects late sees what happens next, not what
* it missed — replaying history would mean holding session content in memory, which is
* exactly what this design refuses to do.
*/
var SessionProjector = class {
	states = /* @__PURE__ */ new Map();
	/**
	* Pending text per session and stream, flushed by the timers below.
	*
	* Keyed by session **and** stream: reasoning and the answer interleave within one
	* turn, and merging them into one buffer would splice the model's thinking into the
	* middle of its reply.
	*/
	pendingText = /* @__PURE__ */ new Map();
	timers = /* @__PURE__ */ new Map();
	/**
	* @param emit - Where projected events go. Called with one event at a time.
	*/
	emit;
	constructor(emit) {
		this.emit = emit;
	}
	/**
	* Feed one log event.
	* @param session - The session whose log grew.
	* @param event - The appended event, exactly as recorded.
	*/
	accept(session, event) {
		const sessionId = session.id;
		const state = this.stateOf(sessionId);
		state.lastActiveAt = event.time;
		if (!FORWARDED.has(event.type)) return;
		switch (event.type) {
			case "turn/start":
				state.running = true;
				this.flushText(sessionId);
				this.send(sessionId, event, "turn/start", {});
				return;
			case "turn/end":
				state.running = false;
				this.flushText(sessionId);
				this.send(sessionId, event, "turn/end", { reason: event.data.reason.kind ?? "unknown" });
				return;
			case "user/message": {
				const text = textOf(event.data.content);
				const context = contextTag(event.data.source);
				if (state.title === "" && context === void 0) state.title = clip(text.trim().replace(/\s+/g, " "), TITLE_LIMIT);
				this.send(sessionId, event, "user/message", {
					text,
					...context ?? {}
				});
				return;
			}
			case "assistant/chunk": {
				const chunk = event.data.chunk;
				if (chunk.type === "text-delta") this.appendText(sessionId, "assistant/chunk", chunk.text);
				else if (chunk.type === "reasoning-delta") this.appendText(sessionId, "assistant/reasoning", chunk.text ?? "");
				return;
			}
			case "tool/call":
				this.flushText(sessionId);
				this.send(sessionId, event, "tool/call", {
					tool: event.data.name,
					argsSummary: clip(event.data.arguments, ARGS_LIMIT)
				});
				return;
			case "tool/result":
				this.send(sessionId, event, "tool/result", {
					tool: "",
					ok: event.data.error === void 0,
					summary: resultSummary(event)
				});
				return;
			case "todo/write":
				this.flushText(sessionId);
				this.send(sessionId, event, "todo/write", { todos: event.data.todos });
				return;
			default: return;
		}
	}
	/**
	* The current session list.
	*
	* Takes the whole logical corpus, not just live sessions: a phone should see what dsh
	* itself lists. Sessions this projector has never seen an event for — anything from
	* before the last restart — still belong there, they just have no observed title yet,
	* so their working directory names them.
	*
	* @param records - Records from ctx.sessionQuery.listSessions(), already newest-first.
	* @param titleOf - dsh's own title for a session, when it has one.
	* @returns Summaries in the order given.
	*/
	summaries(records, titleOf = () => void 0, workspaceOf = () => void 0) {
		return records.map((record) => {
			const state = this.states.get(record.header.id);
			const title = titleOf(record) ?? state?.title;
			const workspace = workspaceOf(record.header.id);
			return {
				sessionId: record.header.id,
				title: title !== void 0 && title !== "" ? title : folderOf(record.header.cwd),
				lastActiveAt: new Date(state?.lastActiveAt ?? record.header.createdAt).toISOString(),
				running: state?.running ?? false,
				...workspace === void 0 ? {} : { workspace }
			};
		});
	}
	/** Drop every timer. Called when the plugin unloads. */
	dispose() {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.pendingText.clear();
		this.states.clear();
	}
	stateOf(sessionId) {
		const existing = this.states.get(sessionId);
		if (existing !== void 0) return existing;
		const created = {
			title: "",
			lastActiveAt: Date.now(),
			running: false
		};
		this.states.set(sessionId, created);
		return created;
	}
	appendText(sessionId, stream, text) {
		if (text === "") return;
		const key = `${sessionId}\u0000${stream}`;
		this.pendingText.set(key, (this.pendingText.get(key) ?? "") + text);
		if (this.timers.has(key)) return;
		const timer = setTimeout(() => {
			this.flushOne(key, sessionId, stream);
		}, COALESCE_MS);
		timer.unref?.();
		this.timers.set(key, timer);
	}
	/** Flush both streams of one session, answer first so ordering stays readable. */
	flushText(sessionId) {
		this.flushOne(`${sessionId}\u0000assistant/reasoning`, sessionId, "assistant/reasoning");
		this.flushOne(`${sessionId}\u0000assistant/chunk`, sessionId, "assistant/chunk");
	}
	flushOne(key, sessionId, stream) {
		const timer = this.timers.get(key);
		if (timer !== void 0) {
			clearTimeout(timer);
			this.timers.delete(key);
		}
		const text = this.pendingText.get(key);
		if (text === void 0 || text === "") return;
		this.pendingText.delete(key);
		this.emit({
			sessionId,
			event: {
				kind: stream,
				at: (/* @__PURE__ */ new Date()).toISOString(),
				payload: { text }
			}
		});
	}
	send(sessionId, event, kind, payload) {
		this.emit({
			sessionId,
			event: {
				kind,
				at: new Date(event.time).toISOString(),
				payload
			}
		});
	}
};

//#endregion
//#region src/history.ts
/**
* How many messages to fetch per page.
*
* 🔴 dsh counts *messages*, and one page of them expands to thousands of raw log events
* — every streamed token is one. Fifteen fills a phone screen several times over and
* keeps the projected frame small enough to cross the wire comfortably.
*/
const PAGE_SIZE = 15;
/**
* Cap on the text a single history page may carry.
*
* A frame that grows without bound eventually exceeds some limit somewhere — and the way
* that failure shows up is the frame silently vanishing, which reads as "opening a
* session hangs forever" with clean logs on both sides. Better to drop the oldest lines
* here, where the reason is visible.
*/
const PAGE_TEXT_BUDGET = 12e4;
/**
* Turn history rows back into session events.
*
* 🔴 A page holds two shapes. Providers stream token-sized deltas, so dsh packs each run
* of them into one `chunkrow/*` row rather than storing hundreds of near-identical lines.
* A reader that only understands `{type:'event'}` therefore drops **every assistant reply
* in the page** and shows a conversation of nothing but the person's own messages.
*
* Each run collapses to a single event rather than one per member: the projection would
* coalesce them anyway, and re-inflating a run only to re-join it wastes the compression
* that made the row worth packing.
*
* @param records - Rows as the controller returned them, oldest first.
* @returns Events in the same order.
*/
function expand(records) {
	const out = [];
	for (const record of records) {
		if (record.type === "event") {
			out.push(record.event);
			continue;
		}
		const run = record.event;
		const text = (run.data?.texts ?? []).join("");
		if (text === "") continue;
		const kind = run.type === "chunkrow/reasoning-chunks" ? "reasoning-delta" : run.type === "chunkrow/text-chunks" ? "text-delta" : void 0;
		if (kind === void 0) continue;
		out.push({
			type: "assistant/chunk",
			seq: run.seq,
			time: run.time,
			data: { chunk: {
				type: kind,
				text
			} }
		});
	}
	return out;
}
/**
* Read one page of history.
*
* @param ctx - Host plugin context.
* @param sessionId - Session to read.
* @param beforeSeq - Fetch events older than this seq; omit for the latest page.
* @returns The page, or undefined when dsh could not answer.
*/
async function readHistory(ctx, sessionId, beforeSeq) {
	const controller = sessions(ctx);
	if (controller === void 0) return void 0;
	const address = {
		kind: "session",
		sessionId
	};
	const opening = await attempt(ctx, "history opening frame", async () => {
		const abort = new AbortController();
		try {
			for await (const frame of controller.follow({
				address,
				maxMessages: PAGE_SIZE
			}, abort.signal)) {
				if (frame.type !== "snapshot") continue;
				return frame;
			}
			return;
		} finally {
			abort.abort();
		}
	});
	if (opening?.cursor === void 0) return void 0;
	let records = opening.records ?? [];
	let more = opening.hasMore === true;
	if (beforeSeq !== void 0) {
		const page = await attempt(ctx, "history page", async () => controller.page({
			address,
			throughSeq: opening.cursor,
			beforeSeq,
			maxMessages: PAGE_SIZE
		}, AbortSignal.timeout(3e4)));
		if (page === void 0) return void 0;
		records = page.records;
		more = page.hasMore;
	}
	const raw = expand(records);
	const oldest = raw[0]?.seq;
	const projected = projectHistory(raw);
	let budget = PAGE_TEXT_BUDGET;
	const kept = [];
	for (let i = projected.length - 1; i >= 0; i -= 1) {
		const event = projected[i];
		if (event === void 0) continue;
		budget -= JSON.stringify(event.payload).length;
		if (budget < 0) break;
		kept.unshift(event);
	}
	return {
		events: kept,
		hasMore: more || kept.length < projected.length,
		...oldest === void 0 ? {} : { oldestSeq: oldest }
	};
}
/**
* Start a new session on this machine.
*
* No cwd is passed: dsh's default is the right answer here. A phone has no sensible
* directory picker, and picking directories is one of the things the harness pins to
* loopback anyway.
*
* @param ctx - Host plugin context.
* @returns Whether dsh accepted it.
*/
async function createSession(ctx) {
	const controller = sessions(ctx);
	if (controller === void 0) return void 0;
	return (await attempt(ctx, "session creation", async () => controller.create({})))?.sessionId;
}
/**
* Rename a session.
*
* @param ctx - Host plugin context.
* @param sessionId - Session to rename.
* @param title - New title.
* @returns Whether dsh accepted it.
*/
async function renameSession(ctx, sessionId, title) {
	const controller = sessions(ctx);
	if (controller === void 0) return false;
	return await attempt(ctx, "session rename", async () => controller.rename({
		sessionId,
		title
	})) !== void 0;
}
/**
* Archive a session, removing it from the list.
*
* Archive rather than delete: dsh's own verb is `archiveSession`, and a phone tap is the
* wrong place to make something unrecoverable.
*
* @param ctx - Host plugin context.
* @param sessionId - Session to archive.
* @returns Whether dsh accepted it.
*/
async function archiveSession(ctx, sessionId) {
	const controller = workspaces(ctx);
	if (controller === void 0) return false;
	return await attempt(ctx, "session archive", async () => controller.archiveSession({ sessionId })) !== void 0;
}

//#endregion
//#region src/settings.ts
/** Namespaces a phone may see and change. Everything else stays on the machine. */
const ALLOWED = new Set([
	"locale",
	"ui-theme",
	"ui-conversation",
	"agent-default-model",
	"agent-loop"
]);
/** Human labels — the harness ships schema, not copy. */
const LABELS = {
	"locale": "语言",
	"ui-theme": "外观",
	"ui-conversation": "忙碌时按回车",
	"agent-default-model": "默认模型",
	"agent-loop": "Agent 循环"
};
const FIELD_LABELS = {
	preference: "偏好",
	busyEnter: "行为",
	provider: "提供方",
	model: "模型",
	maxParallelToolCalls: "并行工具调用上限"
};
/**
* Fields whose dsh schema is an open string but which are, in practice, a choice from a
* small known set — so a phone should offer a picker, not a text box where a typo becomes
* an invalid value. Keyed `${ns}.${key}`.
*
* `locale.preference` is the case that forced this: its schema is
* `z.string().pattern(...)` because the language catalog is extensible (language-pack
* plugins add ids), so no options ride the schema. But the shipped set is zh/en, and a
* phone typing a BCP-47 tag by hand is absurd. When a deployment installs a language pack
* this list will lag it — an annoyance, not a hazard, since an unlisted id is still
* reachable from the desktop.
*/
const ENUM_OVERRIDES = { "locale.preference": ["zh", "en"] };
/**
* Flatten one namespace's schema graph into fields a phone can render.
*
* Only three shapes are handled — an enum (a union of consts), a number, and a string.
* Anything else is skipped rather than guessed at: rendering a control that writes the
* wrong shape back is worse than not offering it.
*/
function fieldsOf(ns, refs, rootUid, value, secrets) {
	const root = refs[String(rootUid)];
	if (root?.type !== "object" || root.dict === void 0) return [];
	const fields = [];
	for (const [key, ref] of Object.entries(root.dict)) {
		if (secrets.includes(key)) continue;
		const node = refs[String(ref)];
		if (node === void 0) continue;
		const current = value[key];
		const label = FIELD_LABELS[key] ?? key;
		const override = ENUM_OVERRIDES[`${ns}.${key}`];
		if (override !== void 0) {
			fields.push({
				key,
				label,
				kind: "enum",
				value: current === void 0 ? null : String(current),
				options: override
			});
			continue;
		}
		if (node.type === "union" && node.list !== void 0) {
			const options = node.list.map((id) => refs[String(id)]).filter((n) => n?.type === "const").map((n) => String(n.value));
			if (options.length > 0) fields.push({
				key,
				label,
				kind: "enum",
				value: current === void 0 ? null : String(current),
				options
			});
			continue;
		}
		if (node.type === "number") {
			fields.push({
				key,
				label,
				kind: "number",
				value: typeof current === "number" ? current : null
			});
			continue;
		}
		if (node.type === "string") fields.push({
			key,
			label,
			kind: "string",
			value: current === void 0 ? null : String(current)
		});
	}
	return fields;
}
/**
* The settings a phone may show.
*
* @param ctx - Host plugin context.
* @returns Groups in the allow-list, or an empty list when dsh could not answer.
*/
async function readSettings(ctx) {
	const controller = settings(ctx);
	if (controller === void 0) return [];
	const value = await attempt(ctx, "settings describe", async () => controller.describe());
	if (value === void 0) return [];
	const groups = [];
	for (const namespace of value.namespaces ?? []) {
		const ns = namespace.ns;
		if (ns === void 0 || !ALLOWED.has(ns)) continue;
		if ((namespace.secrets ?? []).length > 0) continue;
		const refs = namespace.schema?.refs;
		const uid = namespace.schema?.uid;
		if (refs === void 0 || uid === void 0) continue;
		const fields = fieldsOf(ns, refs, uid, namespace.value ?? {}, namespace.secrets ?? []);
		if (fields.length === 0) continue;
		groups.push({
			ns,
			label: LABELS[ns] ?? ns,
			revision: namespace.revision ?? 0,
			fields
		});
	}
	return groups;
}
/**
* Change one setting.
*
* @param ctx - Host plugin context.
* @param ns - Namespace, which must be in the allow-list.
* @param patch - Fields to change.
* @returns Whether dsh accepted it.
*/
async function updateSetting(ctx, ns, patch) {
	if (!ALLOWED.has(ns)) {
		ctx.logger.warn("[pocket] refused a settings write outside the allow-list: %s", ns);
		return false;
	}
	const controller = settings(ctx);
	if (controller === void 0) return false;
	return await attempt(ctx, "settings update", async () => controller.update(ns, patch, void 0)) !== void 0;
}

//#endregion
//#region src/workspaces.ts
/**
* How long to wait for the baseline frame.
*
* 🔴 The workspace domain has no `list()` in dsh 0.1.2 — only `follow()`, a stream whose
* **first** frame is the whole baseline. So this opens the stream, takes that one frame
* and closes it. Without the timeout a controller that never speaks would leave the
* session list waiting forever, and the phone would show nothing at all rather than an
* ungrouped list.
*/
const BASELINE_TIMEOUT_MS = 5e3;
/**
* Build a session id → workspace title map.
*
* @param ctx - Host plugin context.
* @returns The map; empty when dsh has no workspaces or could not answer.
*/
async function workspaceOfSession(ctx) {
	const map = /* @__PURE__ */ new Map();
	const controller = workspaces(ctx);
	if (controller === void 0) return map;
	const abort = new AbortController();
	const timer = setTimeout(() => {
		abort.abort();
	}, BASELINE_TIMEOUT_MS);
	try {
		for await (const frame of controller.follow(abort.signal)) {
			if (frame.type !== "baseline") continue;
			for (const item of frame.value?.workspaces ?? []) {
				if (item.title === "") continue;
				for (const sessionId of item.sessionIds) map.set(sessionId, item.title);
			}
			break;
		}
	} catch {} finally {
		clearTimeout(timer);
		abort.abort();
	}
	return map;
}

//#endregion
//#region src/pairing.ts
/** File name inside the profile directory. */
const FILE = "pocket-pairing-key";
/** Absolute path of the key file. */
function keyPath(profileDir) {
	return join(profileDir, FILE);
}
/**
* Read this machine's pairing key, creating one on first use.
*
* @param profileDir - The profile directory.
* @returns The key.
*/
function pairingKey(profileDir) {
	const path = keyPath(profileDir);
	if (existsSync(path)) try {
		const stored = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
		if (stored.length === 32) return stored;
	} catch {}
	const key = randomBytes(32);
	writeKey(profileDir, key);
	return key;
}
/**
* Replace the key, invalidating every phone that holds the old one.
* @param profileDir - The profile directory.
* @returns The new key.
*/
function rotatePairingKey(profileDir) {
	const key = randomBytes(32);
	writeKey(profileDir, key);
	return key;
}
/**
* Forget the key.
* @param profileDir - The profile directory.
*/
function clearPairingKey(profileDir) {
	const path = keyPath(profileDir);
	if (existsSync(path)) unlinkSync(path);
}
/**
* Whether a signature really came from a phone holding this machine's key.
*
* @param key - The pairing key.
* @param requestId - The approval request being answered.
* @param decision - The answer.
* @param signature - base64url HMAC from the phone.
* @returns true when it verifies.
*/
function verifyApproval(key, requestId, decision, signature) {
	const expected = createHmac("sha256", key).update(`${requestId}:${decision}`).digest();
	let given;
	try {
		given = Buffer.from(signature, "base64url");
	} catch {
		return false;
	}
	if (given.length !== expected.length) return false;
	return timingSafeEqual(given, expected);
}
/** Atomic write with 0600, same discipline as the credentials file. */
function writeKey(profileDir, key) {
	const path = keyPath(profileDir);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	const fd = openSync(temp, "w", 384);
	try {
		writeSync(fd, `${key.toString("base64url")}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, path);
	try {
		chmodSync(path, 384);
	} catch {}
}

//#endregion
//#region src/types.ts
/**
* Wire types for the pocket protocol.
*
* 🔴 The source of truth is the relay's protocol contract, not this file. The relay is
* Java and shares no types with us, so that contract is the only thing keeping the two
* implementations aligned: change it first, then both sides. A field added here alone
* fails silently — the relay simply drops it.
*/
/** Protocol version this build speaks. Sent in `device/hello`; the relay refuses a mismatch. */
const PROTOCOL_VERSION = "0.1.0";

//#endregion
//#region src/relay.ts
/** Reconnect backoff bounds. */
const BACKOFF_MIN_MS = 1e3;
const BACKOFF_MAX_MS = 6e4;
/** Heartbeat period. Must stay under the ALB's 60s idle timeout or the connection dies silently. */
const HEARTBEAT_MS = 3e4;
/** Actions a phone may send. Anything else is ignored rather than answered. */
const ACTIONS = new Set([
	"session.open",
	"session.send",
	"approval.respond",
	"turn.stop",
	"device.rename",
	"model.list",
	"model.select",
	"session.create",
	"session.more",
	"session.list",
	"session.rename",
	"session.archive",
	"pair.request",
	"settings.list",
	"settings.set",
	"question.respond"
]);
/**
* Holds one WebSocket to the relay, re-dialling it whenever it drops.
*
* Node's global WebSocket is used rather than a dependency: dsh requires Node 22.19+,
* where it is a stable global, and the host half is bundled with zero runtime
* dependencies on purpose.
*/
var RelayClient = class {
	socket;
	heartbeat;
	retry;
	attempt = 0;
	stopped = false;
	state = "offline";
	options;
	constructor(options) {
		this.options = options;
	}
	/** Dial the relay and keep it dialled. */
	start() {
		this.stopped = false;
		this.dial();
	}
	/** Stop for good: no further reconnects. */
	stop() {
		this.stopped = true;
		this.clearTimers();
		const socket = this.socket;
		this.socket = void 0;
		socket?.close(1e3, "stopped");
		this.setState("offline");
	}
	/** @returns The current connection state. */
	currentState() {
		return this.state;
	}
	/**
	* Send one projected session event, if connected.
	* @param projected - The event to forward.
	*/
	sendSessionEvent(projected) {
		this.send({
			t: "session/event",
			sessionId: projected.sessionId,
			event: projected.event
		});
	}
	/**
	* Send the model catalog for one session.
	* @param sessionId - The session it describes.
	* @param catalog - Current selection plus the options.
	*/
	sendModelCatalog(sessionId, catalog) {
		this.send({
			t: "model/catalog",
			sessionId,
			...catalog
		});
	}
	/**
	* Send one page of a session's past.
	* @param sessionId - The session it belongs to.
	* @param page - Projected events plus paging state.
	*/
	sendHistory(sessionId, page) {
		this.send({
			t: "session/history",
			sessionId,
			...page
		});
	}
	/**
	* Hand the signing key to a phone that does not have it yet.
	* @param key - base64url key.
	*/
	sendPairingKey(key) {
		this.send({
			t: "pair/key",
			key
		});
	}
	/**
	* Send the settings a phone may show.
	* @param groups - Flattened setting groups.
	*/
	sendSettings(groups) {
		this.send({
			t: "settings/list",
			groups
		});
	}
	/** Push the current session list. */
	sendSessionList() {
		this.options.listSessions().then((sessions$1) => {
			this.send({
				t: "session/list",
				sessions: sessions$1
			});
		}).catch(() => {});
	}
	/**
	* Tell the phones something they asked for did not happen.
	*
	* 🔴 Without this a plugin-side failure only reaches this machine's log, and the phone
	* shows nothing at all — "I pressed send and nothing happened" is harder to diagnose
	* than any error message. Sending an image is the case that made this necessary: the
	* bytes can be refused for half a dozen reasons the person can actually act on
	* (too big, wrong format, no attachment store on this machine).
	*
	* @param code - Short machine-readable reason.
	* @param message - What to show the person. Never a path or a stack.
	*/
	sendError(code, message) {
		this.send({
			t: "error",
			code,
			message
		});
	}
	/**
	* Put the agent's question to the watching phones.
	*
	* Unlike an approval this always goes out, even with nobody attached: the host keeps
	* the question pending and replays it to whoever opens the stream next, so there is
	* nothing here to fail.
	*
	* @param ask - The question and its rpcId.
	*/
	sendQuestion(ask) {
		this.send({
			t: "question/ask",
			...ask
		});
	}
	/**
	* Tell the phones a question is no longer open.
	*
	* It may have been answered on the computer, or on another phone, or the turn may have
	* been cancelled underneath it. All three look the same from here and all three mean
	* the same thing on screen: take the card down.
	*
	* @param rpcId - The question that closed.
	*/
	sendQuestionResolved(rpcId) {
		this.send({
			t: "question/resolved",
			rpcId
		});
	}
	/**
	* Ask the watching phones to decide one tool call.
	* @param request - The pending decision.
	* @returns false when there is no live connection to ask over.
	*/
	sendApproval(request) {
		const socket = this.socket;
		if (socket === void 0 || socket.readyState !== WebSocket.OPEN) return false;
		this.send({
			t: "approval/request",
			...request
		});
		return true;
	}
	async dial() {
		if (this.stopped) return;
		this.setState("connecting");
		let ticket;
		try {
			ticket = await this.fetchTicket();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.options.log.warn("[pocket] could not get a relay ticket: %s", detail);
			this.setState("offline", detail);
			this.scheduleRetry();
			return;
		}
		if (this.stopped) return;
		const url = `${this.options.relayOrigin.replace(/^http/, "ws")}/ws/device?ticket=${encodeURIComponent(ticket.ticket)}&slot=${String(ticket.shard)}`;
		const socket = new WebSocket(url);
		this.socket = socket;
		socket.addEventListener("open", () => {
			this.attempt = 0;
			this.setState("online");
			this.startHeartbeat();
			this.options.log.info("[pocket] connected to the relay");
			this.options.listSessions().catch(() => []).then((sessions$1) => {
				this.send({
					t: "device/hello",
					protocolVersion: PROTOCOL_VERSION,
					deviceId: this.options.credentials.deviceId,
					deviceName: this.options.credentials.deviceName,
					dshVersion: this.options.dshVersion,
					pluginVersion: this.options.pluginVersion,
					sessions: sessions$1
				});
			});
		});
		socket.addEventListener("message", (event) => {
			this.receive(typeof event.data === "string" ? event.data : "");
		});
		socket.addEventListener("close", (event) => {
			this.clearTimers();
			this.socket = void 0;
			this.guard("viewer count reset", () => {
				this.options.onViewers(0);
			});
			this.setState("offline");
			if (!this.stopped) {
				this.options.log.debug("[pocket] relay connection closed (code=%s), will retry", event.code);
				this.scheduleRetry();
			}
		});
		socket.addEventListener("error", () => {
			this.options.log.debug("[pocket] relay socket error");
		});
	}
	async fetchTicket() {
		const response = await fetch(`${this.options.relayOrigin}/api/v1/public/pocket/device-ticket`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deviceSecret: this.options.credentials.token })
		});
		if (!response.ok) throw new Error(`ticket request failed (HTTP ${String(response.status)})`);
		const body = await response.json();
		const ticket = body.data?.ticket;
		if (typeof ticket !== "string" || ticket === "") throw new Error("the relay issued no ticket; this machine may have been revoked");
		return {
			ticket,
			shard: typeof body.data?.shard === "number" ? body.data.shard : 0
		};
	}
	/**
	* Run a handler without letting it take the harness down.
	*
	* 🔴 These callbacks run from a WebSocket event. A throw inside one has no catcher
	* above it, so Node re-raises it on the next tick and **the whole dsh process exits** —
	* which is exactly what happened when a service was read without being injected
	* (2026-08-31). A relay-carried frame must never be able to do that: the worst a bad
	* frame deserves is a log line.
	*
	* @param label - What was being done, for the log.
	* @param run - The handler.
	*/
	guard(label, run) {
		try {
			run();
		} catch (error) {
			this.options.log.warn("[pocket] %s failed and was contained: %s", label, String(error));
		}
	}
	receive(payload) {
		if (payload === "") return;
		let frame;
		try {
			frame = JSON.parse(payload);
		} catch {
			this.options.log.warn("[pocket] dropped an unparseable frame from the relay");
			return;
		}
		const type = typeof frame.t === "string" ? frame.t : void 0;
		if (type === void 0) return;
		if (type === "ping") {
			this.send({ t: "pong" });
			return;
		}
		if (type === "pong") return;
		if (type === "viewer/count") {
			const count = frame.count;
			this.guard("viewer count", () => {
				this.options.onViewers(typeof count === "number" ? count : 0);
			});
			return;
		}
		if (type === "error") {
			const code = frame.code;
			this.options.log.warn("[pocket] the relay refused a frame: %s", typeof code === "string" ? code : "unknown");
			return;
		}
		if (!ACTIONS.has(type)) {
			this.options.log.debug("[pocket] ignoring an unknown action: %s", type);
			return;
		}
		this.guard(`action ${String(frame["t"])}`, () => {
			this.options.onAction(frame);
		});
	}
	send(frame) {
		const socket = this.socket;
		if (socket === void 0 || socket.readyState !== WebSocket.OPEN) return;
		socket.send(JSON.stringify(frame));
	}
	startHeartbeat() {
		this.heartbeat = setInterval(() => {
			this.send({ t: "ping" });
		}, HEARTBEAT_MS);
		this.heartbeat.unref?.();
	}
	scheduleRetry() {
		this.attempt += 1;
		const base = Math.min(BACKOFF_MIN_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS);
		const delay = base / 2 + Math.random() * (base / 2);
		this.retry = setTimeout(() => {
			this.dial();
		}, delay);
		this.retry.unref?.();
	}
	clearTimers() {
		if (this.heartbeat !== void 0) clearInterval(this.heartbeat);
		if (this.retry !== void 0) clearTimeout(this.retry);
		this.heartbeat = void 0;
		this.retry = void 0;
	}
	setState(state, error) {
		this.state = state;
		this.options.onState(state, error);
	}
};

//#endregion
//#region src/index.ts
/** Plugin name (the `name` of the loader entry). */
const name = "dsh-pocket";
/**
* The web server carries the local routes; the session store is what pocket projects to
* the phone. Neither is optional, so both are hard injections.
*/
const inject = [
	"webServer",
	"sessions",
	"agents"
];
/** Route prefix. The client half builds its URLs from the same constant. */
const API_PREFIX = "/pocket/api";
/** Plugin version, sent in the hello frame. Bump it together with package.json. */
const PLUGIN_VERSION = "0.1.0";
/** Default endpoints. Overridable so a staging profile can point elsewhere. */
const DEFAULT_ACCOUNT_ORIGIN = "https://account.a2hmarket.ai";
const DEFAULT_USER_ORIGIN = "https://api.a2hmarket.ai/findu-user";
const DEFAULT_RELAY_ORIGIN = "https://api-prod.a2hmarket.ai/a2hmarket-pocket";
/** JSON response. */
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/**
* Allow state-changing operations only from a direct local connection.
*
* Only the socket's peer address counts, and any forwarding header is an outright
* refusal — a reverse proxy relaying an external request also looks like 127.0.0.1 on
* the socket, so the address alone would hollow out the guarantee.
*/
function isDirectLoopback(req) {
	if (req.headers["x-forwarded-for"] !== void 0 || req.headers["x-forwarded-host"] !== void 0) return false;
	const address = req.socket.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
/** Same-origin POST: when Origin is present it must match Host, blocking other pages from commanding the local port. */
function isSameOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}
/**
* Mount pocket's local surface.
* @param ctx - Host plugin context.
* @param config - Resolved plugin config.
*/
function apply(ctx, config) {
	const endpoints = {
		accountOrigin: config?.accountOrigin ?? DEFAULT_ACCOUNT_ORIGIN,
		userOrigin: config?.userOrigin ?? DEFAULT_USER_ORIGIN,
		relayOrigin: config?.relayOrigin ?? DEFAULT_RELAY_ORIGIN
	};
	const enabled = config?.enabled ?? false;
	const profileDir = profileDirOf(ctx.baseUrl);
	let relay;
	let relayState = "offline";
	let lastError;
	let viewers = 0;
	let droppedApprovals = 0;
	const projector = new SessionProjector((projected) => {
		relay?.sendSessionEvent(projected);
	});
	const approvals = new PhoneApprovals({
		viewers: () => viewers,
		ask: (request) => relay?.sendApproval(request) ?? false,
		log: ctx.logger
	});
	/**
	* The session list comes from sessionQuery — the whole corpus, including sessions
	* that were never loaded into memory.
	*
	* 🔴 Not ctx.sessions.list(): that holds only what is live right now, so after any
	* dsh restart it is empty and the phone shows "no sessions on this machine" while
	* dsh's own window lists dozens. sessionQuery is optional; without it, fall back to
	* the live list — worse than the real thing, better than nothing.
	*/
	/**
	* The title dsh's own list shows, read the way it reads it: live sessions from the
	* projection registry, cold ones from the persisted projection cache. Neither path
	* loads a full log — that cache exists for exactly this listing case.
	*
	* Any failure means "no title". A row missing its title is degraded; throwing here
	* would blank the whole list.
	*/
	const titleOf = (record) => {
		try {
			const live = ctx.sessions.get(record.header.id);
			const title = (live !== void 0 ? ctx.get("sessionProjections")?.snapshot(live) : ctx.get("sessionProjectionCache")?.cachedSnapshot(record.header))?.values["title"];
			return typeof title === "string" && title !== "" ? title : void 0;
		} catch {
			return;
		}
	};
	const listSessions = async () => {
		const workspaces$1 = await workspaceOfSession(ctx);
		const workspaceOf = (sessionId) => workspaces$1.get(sessionId);
		const query = ctx.get("sessionQuery");
		if (query === void 0) return projector.summaries(ctx.sessions.list().map((session) => ({
			header: session.header,
			live: true,
			persisted: false
		})), titleOf, workspaceOf);
		return projector.summaries(await query.listSessions(), titleOf, workspaceOf);
	};
	const renameDevice = (name$1) => {
		if (profileDir === void 0) return;
		const current = readCredentials(profileDir);
		if (current === void 0) return;
		writeCredentials(profileDir, {
			...current,
			deviceName: name$1
		});
	};
	const questions = new PhoneQuestions({
		viewers: () => viewers,
		ask: (ask) => {
			relay?.sendQuestion(ask);
		},
		resolved: (rpcId) => {
			relay?.sendQuestionResolved(rpcId);
		},
		log: ctx.logger
	});
	ctx.effect(() => ctx.on("user-questions/request", (request, next) => questions.answer(request, next), true), "pocket: user-question answerer");
	ctx.effect(() => () => {
		questions.releaseAll();
	}, "pocket: release pending questions");
	const onAction = (action) => {
		if (action.t === "approval.respond") {
			if (profileDir === void 0) return;
			const signature = action.sig;
			if (signature === void 0 || !verifyApproval(pairingKey(profileDir), action.requestId, action.decision, signature)) {
				droppedApprovals += 1;
				ctx.logger.warn("[pocket] an approval answer failed signature check and was dropped");
				return;
			}
			approvals.resolve(action.requestId, action.decision);
			return;
		}
		if (action.t === "pair.request") {
			if (profileDir !== void 0) relay?.sendPairingKey(pairingKey(profileDir).toString("base64url"));
			return;
		}
		if (action.t === "settings.list") {
			readSettings(ctx).then((groups) => {
				relay?.sendSettings(groups);
			});
			return;
		}
		if (action.t === "settings.set") {
			updateSetting(ctx, action.ns, action.patch).then(() => readSettings(ctx)).then((groups) => {
				relay?.sendSettings(groups);
			});
			return;
		}
		if (action.t === "session.list") {
			relay?.sendSessionList();
			return;
		}
		if (action.t === "session.open") {
			readHistory(ctx, action.sessionId).then((page) => {
				if (page !== void 0) relay?.sendHistory(action.sessionId, { ...page });
			});
			return;
		}
		if (action.t === "session.more") {
			readHistory(ctx, action.sessionId, action.beforeSeq).then((page) => {
				if (page !== void 0) relay?.sendHistory(action.sessionId, { ...page });
			});
			return;
		}
		if (action.t === "session.create") {
			createSession(ctx).then((sessionId) => {
				if (sessionId === void 0) {
					relay?.sendError("create-failed", "新建会话失败");
					return;
				}
				relay?.sendSessionList();
			});
			return;
		}
		if (action.t === "session.rename") {
			renameSession(ctx, action.sessionId, action.title).then((ok) => {
				if (ok) relay?.sendSessionList();
			});
			return;
		}
		if (action.t === "session.archive") {
			archiveSession(ctx, action.sessionId).then((ok) => {
				if (ok) relay?.sendSessionList();
			});
			return;
		}
		if (action.t === "model.list") {
			readCatalog(ctx, action.sessionId).then((catalog) => {
				if (catalog !== void 0) {
					relay?.sendModelCatalog(action.sessionId, { ...catalog });
					return;
				}
				relay?.sendError("model-catalog-failed", takeFailure() ?? "读不到模型列表");
			});
			return;
		}
		if (action.t === "model.select") {
			selectModel(ctx, action.sessionId, action.provider, action.model).then(() => readCatalog(ctx, action.sessionId)).then((catalog) => {
				if (catalog !== void 0) relay?.sendModelCatalog(action.sessionId, { ...catalog });
			});
			return;
		}
		if (action.t === "question.respond") {
			questions.resolve(action.rpcId, action.answers.map((a) => ({
				id: a.id,
				selected: [...a.selected],
				...a.custom === void 0 ? {} : { custom: a.custom }
			})));
			return;
		}
		if (action.t === "session.send") {
			speak(ctx, action.sessionId, action.text, action.images ?? []).then((reason) => {
				if (reason === void 0) return;
				ctx.logger.warn("[pocket] 消息没发出去：%s", reason);
				relay?.sendError("send-failed", reason);
			});
			return;
		}
		if (runAction(ctx, action, renameDevice) === "no-such-session") ctx.logger.debug("[pocket] %s targeted a session that is no longer live", action.t);
	};
	const startRelay = () => {
		if (!enabled || profileDir === void 0 || relay !== void 0) return;
		const credentials = readCredentials(profileDir);
		if (credentials === void 0) return;
		if (needsSecretUpgrade(credentials)) {
			upgradeToDeviceSecret(endpoints, credentials).then((upgraded) => {
				writeCredentials(profileDir, upgraded);
				ctx.logger.info("[pocket] traded the account token for a device secret");
				startRelay();
			}).catch((error) => {
				lastError = error instanceof Error ? error.message : String(error);
				ctx.logger.warn("[pocket] could not obtain a device secret: %s", lastError);
			});
			return;
		}
		relay = new RelayClient({
			relayOrigin: endpoints.relayOrigin,
			credentials,
			dshVersion: process.env["DSH_VERSION"] ?? "unknown",
			pluginVersion: PLUGIN_VERSION,
			listSessions,
			onAction,
			onViewers: (count) => {
				const before = viewers;
				viewers = count;
				if (count > before) relay?.sendSessionList();
				if (count === 0) questions.releaseAll();
			},
			onState: (state, error) => {
				relayState = state;
				lastError = error;
			},
			log: ctx.logger
		});
		relay.start();
	};
	const stopRelay = () => {
		relay?.stop();
		relay = void 0;
		relayState = "offline";
		viewers = 0;
	};
	const status = () => {
		if (profileDir === void 0) return {
			enabled,
			linked: false,
			connection: "offline",
			viewers: 0,
			linking: false,
			droppedApprovals,
			questionsSeen: questions.seen,
			lastError: "cannot resolve the profile directory"
		};
		const credentials = readCredentials(profileDir);
		if (credentials === void 0) return {
			enabled,
			linked: false,
			connection: "offline",
			viewers: 0,
			linking: isLinking(),
			droppedApprovals,
			questionsSeen: questions.seen,
			...lastError === void 0 ? {} : { lastError }
		};
		return {
			enabled,
			linked: true,
			deviceId: credentials.deviceId,
			deviceName: credentials.deviceName,
			connection: relayState,
			viewers,
			linking: isLinking(),
			droppedApprovals,
			questionsSeen: questions.seen,
			...lastError === void 0 ? {} : { lastError }
		};
	};
	const handle = async (req, res) => {
		const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
		if (path === `${API_PREFIX}/status`) {
			json(res, 200, status());
			return;
		}
		if (!isDirectLoopback(req) || !isSameOrigin(req)) {
			json(res, 403, { error: "forbidden" });
			return;
		}
		if (path === `${API_PREFIX}/link` && req.method === "POST") {
			if (profileDir === void 0) {
				json(res, 500, { error: "cannot resolve the profile directory" });
				return;
			}
			json(res, 200, beginLink(endpoints, (outcome) => {
				if (!outcome.ok) {
					lastError = outcome.detail;
					ctx.logger.warn("[pocket] linking failed: %s", outcome.detail);
					return;
				}
				lastError = void 0;
				writeCredentials(profileDir, outcome.credentials);
				ctx.logger.info("[pocket] this machine is linked as %s", outcome.credentials.deviceId);
				startRelay();
			}));
			return;
		}
		if (path === `${API_PREFIX}/pairing/rotate` && req.method === "POST") {
			if (profileDir !== void 0) rotatePairingKey(profileDir);
			ctx.logger.info("[pocket] signing key rotated; phones will pick up the new one on reconnect");
			json(res, 200, { ok: true });
			return;
		}
		if (path === `${API_PREFIX}/unlink` && req.method === "POST") {
			cancelLink();
			stopRelay();
			if (profileDir !== void 0) {
				clearCredentials(profileDir);
				clearPairingKey(profileDir);
			}
			ctx.logger.info("[pocket] this machine is no longer linked");
			json(res, 200, status());
			return;
		}
		json(res, 404, { error: "not found" });
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/pocket",
		handler: (req, res) => {
			handle(req, res);
		}
	}), "pocket: local routes");
	ctx.effect(() => ctx.on("session/event", (session, event) => {
		projector.accept(session, event);
	}), "pocket: session feed");
	ctx.effect(() => ctx.on("approval/request", (req, next) => approvals.answer(req, next), true), "pocket: approval answerer");
	ctx.effect(() => () => {
		stopRelay();
		approvals.dispose();
		projector.dispose();
	}, "pocket: relay lifetime");
	startRelay();
}

//#endregion
export { API_PREFIX, PROTOCOL_VERSION, apply, inject, name };