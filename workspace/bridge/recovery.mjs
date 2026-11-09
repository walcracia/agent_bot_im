export const PAUSED_PHASES = new Set(['started', 'uncertain', 'routing_failed']);

/** Deliberately exact: discussion, quotations and extra instructions are not controls. */
export function recoveryCommand(text, botUsername) {
  if (typeof text !== 'string') return null;
  let value = text.trim();
  const name = String(botUsername ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (name) value = value.replace(new RegExp(`^@${name}(?:\\s+|[，,:：]\\s*)`, 'iu'), '');
  value = value.replace(/[。.!！?？]+$/u, '').trim();
  if (['继续', '继续修正', '继续任务', '恢复任务', '重试任务'].includes(value)) return 'resume';
  if (['取消任务', '跳过任务'].includes(value)) return 'cancel';
  return null;
}

export function recoveryAllowed(event, conversation, config, botId) {
  return Boolean(event && !event.sender?.is_bot && event.sender?.id !== botId
    && config.conversationIds.includes(event.conversation_id) && config.senderIds.includes(event.sender?.id)
    && conversation?.id === event.conversation_id && Array.isArray(conversation.members)
    && conversation.members.some(member => member.id === botId && member.is_bot)
    && conversation.members.some(member => member.id === event.sender.id && !member.is_bot));
}

export function pauseText(notice, config) {
  if (notice.processTreeStopped === false) return '任务执行已中断，执行进程尚未确认退出，需要在本机核对；任务保持暂停，已有修改保留。';
  if (notice.kind === 'routing') return '任务识别未完成，尚未开始代码修改。发送“继续修正”重新识别，或发送“取消任务”放弃本次任务。';
  const timeout = notice.kind === 'timeout';
  const milliseconds = config.harness?.runTimeoutMs ?? 7200000;
  const limit = milliseconds % 3600000 === 0 ? `${milliseconds / 3600000}小时` : `${Math.ceil(milliseconds / 1000)}秒`;
  return `${timeout ? `任务执行达到${limit}上限` : '任务执行已中断'}，已有修改和记录已保留。发送“继续修正”接续原任务，先检查已有改动；或发送“取消任务”结束等待，保留代码。`;
}

export const CONTINUATION_INSTRUCTION = '这是用户明确要求的中断接续。先核对当前 Git diff、已有文件和已完成步骤，保留已有修改，沿用原会话继续未完成工作；不要 reset、清空或重复完成已做步骤。完成后核对真实差异、运行相关验证，并明确尚未完成的事项。';
