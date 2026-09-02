/**
 * Carrying out what a phone asked for.
 *
 * Every action resolves the agent by session id and refuses when it is gone. A phone
 * holds a view that can be seconds stale — the session it is looking at may have been
 * disposed since — so "no such agent" is an ordinary outcome here, not an error path.
 */

import type { Context, ImageMediaType, PromptContentPart } from '@deepseek-ai/cordis'
import { attempt, sessions } from './models.ts'
import type { OutgoingImage, PocketAction } from './types.ts'

/** Longest message accepted from a phone, matching the contract's `session.send`. */
const TEXT_LIMIT = 8000

/** What running an action produced, for the log. */
export type ActionOutcome = 'done' | 'no-such-session' | 'ignored'

/**
 * Run one action from a phone.
 *
 * @param ctx - Host plugin context, for the agent registry and logging.
 * @param action - The action, already validated as one of the allowed kinds.
 * @param onRename - Applies a new device name locally.
 * @returns What happened, so the caller can log one line.
 */
export function runAction(
  ctx: Context,
  action: PocketAction,
  onRename: (name: string) => void,
): ActionOutcome {
  switch (action.t) {
    case 'session.open':
      // Subscription lives in the relay, not here: opening a session is the phone
      // telling the relay what to route, and nothing happens on this machine.
      return 'ignored'

    case 'session.send':
      // Asynchronous; handled by speak() from the dispatcher.
      return 'ignored'

    case 'turn.stop': {
      const controller = sessions(ctx)
      if (controller === undefined) return 'ignored'
      try {
        controller.cancel({ sessionId: action.sessionId })
        return 'done'
      } catch {
        // Nothing was running, or the session is gone. Both are ordinary.
        return 'ignored'
      }
    }

    case 'device.rename':
      onRename(action.name.slice(0, 40))
      return 'done'

    case 'approval.respond':
      // Answered by the approval waterfall, which is waiting on its own promise.
      return 'ignored'

    default:
      return 'ignored'
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
export async function speak(
  ctx: Context,
  sessionId: string,
  text: string,
  images: readonly OutgoingImage[] = [],
): Promise<string | undefined> {
  const controller = sessions(ctx)
  if (controller === undefined) return '这台电脑上的 dsh 没有会话控制器'

  const trimmed = text.slice(0, TEXT_LIMIT)
  // 只发一张照片、不写字是正常的——「你看这个」本来就不需要配文
  if (trimmed.trim() === '' && images.length === 0) return undefined

  const content: PromptContentPart[] = []
  if (trimmed !== '') content.push({ type: 'text', text: trimmed })
  for (const image of images) {
    /*
     * 这里断言媒体类型：字符串是从手机端来的，而宿主只认四种。传错了 prompt() 自己会拒，
     * 拒绝原因会经 attempt 记进日志并回给手机——不在这里预先校验，是为了不把宿主的规则
     * 抄一份在插件里（抄了就会漂移）。
     */
    content.push({
      type: 'image',
      mediaType: image.mediaType as ImageMediaType,
      data: image.data,
    })
  }

  const accepted = await attempt(ctx, 'prompt', async () => controller.prompt({
    requestId: crypto.randomUUID(),
    sessionId,
    // queue，不是 steer：steer 会切进当前这一步，那是另一种意图
    mode: 'queue',
    content,
  }, AbortSignal.timeout(60_000)))
  return accepted === undefined ? '发送失败，电脑那边没接受' : undefined
}
