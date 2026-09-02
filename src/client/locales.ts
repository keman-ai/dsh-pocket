/** UI strings. Keys are shared by both dictionaries; a missing key falls back to the key itself. */

export const en: Record<string, string> = {
  nav: 'Pocket',
  title: 'Use this agent from your phone',
  intro: 'Link this machine to an A2H Market account, then open dsh-pocket.a2hmarket.ai on your phone to watch this agent work, answer its approval requests, and stop a turn that is going wrong.',
  stateUnlinked: 'Not linked',
  stateLinked: 'Linked as {name}',
  stateOffline: 'Not connected to the relay',
  stateConnecting: 'Connecting…',
  stateOnline: 'Connected · {viewers} phone(s) attached',
  link: 'Link an A2H account',
  waiting: 'Waiting for you to confirm…',
  waitingHint: 'Confirm in the browser tab that just opened. This page updates by itself once you do.',
  unlink: 'Unlink this machine',
  linkHint: 'A browser tab will open for you to approve.',
  disabledTitle: 'Turned off',
  disabledBody: 'Pocket is switched off in this profile, so nothing is connected. Turn it on in cordis.patch.yml to use it.',
  failed: 'Something went wrong: {detail}',
}

export const zh: Record<string, string> = {
  nav: '手机接管',
  title: '在手机上接手这个 agent',
  intro: '把这台机器连到 A2H Market 账号，然后在手机上打开 dsh-pocket.a2hmarket.ai，就能看它干活、回复它的审批请求、叫停跑偏的任务。',
  stateUnlinked: '未连接账号',
  stateLinked: '已连接为 {name}',
  stateOffline: '未连上中继',
  stateConnecting: '连接中…',
  stateOnline: '已连接 · {viewers} 台手机在看',
  link: '连接 A2H 账号',
  waiting: '等你确认…',
  waitingHint: '在刚打开的浏览器标签页里点确认，这里会自己变。',
  unlink: '解除本机连接',
  linkHint: '会打开一个浏览器标签页让你确认授权。',
  disabledTitle: '未启用',
  disabledBody: '这个 profile 里 pocket 是关着的，不会连任何东西。要用就在 cordis.patch.yml 里打开。',
  failed: '出错了：{detail}',
}
