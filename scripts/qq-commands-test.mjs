/**
 * QQ 指令解析单测(纯函数,无需 Electron)。
 * 用法:node scripts/qq-commands-test.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseCommand, parseTaskOptions, parseApprovalButtonData, findEventUserId, findEventGroupOpenid, parseQuestionButtonData, parseActionButtonData } = require('../dist/main/qq-commands.js')

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`✓ ${name}`)
  } else {
    failures++
    console.log(`✗ ${name}\n    期望 ${e}\n    实际 ${a}`)
  }
}

// 基础指令
check('帮助', parseCommand('帮助'), { kind: 'help' })
check('help', parseCommand('help'), { kind: 'help' })
check('状态', parseCommand('状态'), { kind: 'status' })
check('status', parseCommand('status'), { kind: 'status' })
check('会话', parseCommand('会话'), { kind: 'sessions' })
check('工作区', parseCommand('工作区'), { kind: 'workspaces' })
check('模型', parseCommand('模型'), { kind: 'models' })

// 带参指令
check('停止', parseCommand('停止 session-abc'), { kind: 'cancel', sessionId: 'session-abc' })
check('cancel 无参', parseCommand('cancel'), { kind: 'cancel', sessionId: '' })
check('打开', parseCommand('打开 session-abc'), { kind: 'open', sessionId: 'session-abc' })
check('进展', parseCommand('进展 session-abc'), { kind: 'progress', sessionId: 'session-abc' })
check('progress', parseCommand('progress session-abc'), { kind: 'progress', sessionId: 'session-abc' })
check('任务', parseCommand('任务 分析这个仓库'), { kind: 'run', description: '分析这个仓库' })
check('run', parseCommand('run 分析仓库'), { kind: 'run', description: '分析仓库' })
check('执行', parseCommand('执行 写一个脚本'), { kind: 'run', description: '写一个脚本' })
check('进入', parseCommand('进入 qqbot'), { kind: 'enter', target: 'qqbot' })
check('enter 路径', parseCommand('enter D:/work/proj'), { kind: 'enter', target: 'D:/work/proj' })
check('进入工作区', parseCommand('进入工作区 my-ws'), { kind: 'enter', target: 'my-ws' })
check('退出', parseCommand('退出'), { kind: 'exit' })
check('exit', parseCommand('exit'), { kind: 'exit' })
check('结束', parseCommand('结束'), { kind: 'exit' })

// 审批/提问应答
check('允许', parseCommand('允许'), { kind: 'allow', sessionId: '' })
check('允许 带会话', parseCommand('允许 session-abc'), { kind: 'allow', sessionId: 'session-abc' })
check('同意', parseCommand('同意'), { kind: 'allow', sessionId: '' })
check('批准', parseCommand('批准'), { kind: 'allow', sessionId: '' })
check('approve', parseCommand('approve'), { kind: 'allow', sessionId: '' })
check('拒绝', parseCommand('拒绝'), { kind: 'reject', sessionId: '' })
check('拒绝 带会话', parseCommand('拒绝 session-abc'), { kind: 'reject', sessionId: 'session-abc' })
check('reject', parseCommand('reject'), { kind: 'reject', sessionId: '' })
check('选 单选', parseCommand('选 2'), { kind: 'select', text: '2' })
check('选择 多选', parseCommand('选择 1 3'), { kind: 'select', text: '1 3' })
check('select 自定义', parseCommand('select 自定义:先备份再删'), { kind: 'select', text: '自定义:先备份再删' })
check('选 指定题号', parseCommand('选 #2 1'), { kind: 'select', text: '#2 1' })
check('选 指定题号-前缀', parseCommand('#2 选 1 自定义:x'), { kind: 'select', text: '#2 1 自定义:x' })
check('选 指定题号-前缀-空', parseCommand('#1 选'), { kind: 'select', text: '#1' })
check('选 空', parseCommand('选'), { kind: 'select', text: '' })

// 未知
check('未知指令', parseCommand('你好啊'), { kind: 'unknown', text: '你好啊' })
check('空指令', parseCommand('  '), { kind: 'unknown', text: '' })

// 任务选项解析
check('任务选项-工作区', parseTaskOptions('分析代码 @my-project'), {
  description: '分析代码',
  cwd: null,
  workspaceName: 'my-project',
})
check('任务选项-目录', parseTaskOptions('分析代码 目录:D:/projects/a'), {
  description: '分析代码',
  cwd: 'D:/projects/a',
  workspaceName: null,
})
check('任务选项-两者', parseTaskOptions('分析 @ws 目录:D:/x'), {
  description: '分析',
  cwd: 'D:/x',
  workspaceName: 'ws',
})
check('任务选项-无', parseTaskOptions('分析代码'), {
  description: '分析代码',
  cwd: null,
  workspaceName: null,
})

// 审批按钮 data 解析(INTERACTION_CREATE 回传)
check('按钮-标准', parseApprovalButtonData('dsh-approve|session-abc|ap-1|allowed-once'), {
  sessionId: 'session-abc', approvalId: 'ap-1', decision: 'allowed-once',
})
check('按钮-拒绝', parseApprovalButtonData('dsh-approve|session-abc|ap-1|rejected'), {
  sessionId: 'session-abc', approvalId: 'ap-1', decision: 'rejected',
})
check('按钮-嵌套 resolved', parseApprovalButtonData({ resolved: { button_data: 'dsh-approve|s1|a2|allowed-once' } }), {
  sessionId: 's1', approvalId: 'a2', decision: 'allowed-once',
})
check('按钮-非法决策', parseApprovalButtonData('dsh-approve|s1|a2|maybe'), null)
check('按钮-非审批前缀', parseApprovalButtonData('other|s1|a2|allowed-once'), null)
check('按钮-非对象', parseApprovalButtonData(42), null)
check('点击者 openid', findEventUserId({ resolved: { user_id: 'OPENID_1', button_data: 'x' } }), 'OPENID_1')
check('点击者 缺失', findEventUserId({ resolved: { button_data: 'x' } }), '')
check('点击者 非对象', findEventUserId('str'), '')
check('群 openid', findEventGroupOpenid({ detail: { group_openid: 'GROUP_9', button_data: 'x' } }), 'GROUP_9')
check('群 openid 嵌套', findEventGroupOpenid({ detail: { resolved: { group_openid: 'GROUP_9' } } }), 'GROUP_9')
check('群 openid 缺失', findEventGroupOpenid({ resolved: { user_id: 'U' } }), '')
check('群 openid 非对象', findEventGroupOpenid(7), '')
check('提问按钮-解析', parseQuestionButtonData('dsh-question|session-a|q1|2'), { sessionId: 'session-a', questionId: 'q1', optionIndex: 2 })
check('提问按钮-嵌套', parseQuestionButtonData({ resolved: { button_data: 'dsh-question|s1|q2|0' } }), { sessionId: 's1', questionId: 'q2', optionIndex: 0 })
check('提问按钮-非法索引', parseQuestionButtonData('dsh-question|s1|q1|x'), null)
check('提问按钮-其他前缀', parseQuestionButtonData('dsh-approve|s1|a1|allowed-once'), null)
check('操作按钮-停止', parseActionButtonData('dsh-action|stop|session-a'), { action: 'stop', sessionId: 'session-a' })
check('操作按钮-进展', parseActionButtonData('dsh-action|progress|session-a'), { action: 'progress', sessionId: 'session-a' })
check('操作按钮-打开', parseActionButtonData('dsh-action|open|session-a'), { action: 'open', sessionId: 'session-a' })
check('操作按钮-嵌套', parseActionButtonData({ resolved: { button_data: 'dsh-action|stop|s1' } }), { action: 'stop', sessionId: 's1' })
check('操作按钮-非法动作', parseActionButtonData('dsh-action|delete|s1'), null)
check('操作按钮-其他前缀', parseActionButtonData('dsh-approve|s1|a1|rejected'), null)

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 个失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
