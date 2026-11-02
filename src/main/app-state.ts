/**
 * 全局应用状态。
 *
 * 只为一件事存在：区分「用户点红绿灯关闭窗口」和「用户真的要退出应用」。
 * 前者只隐藏窗口（决策 D3），后者才允许真正销毁。
 */
let quitting = false

export function isQuitting(): boolean {
  return quitting
}

export function setQuitting(value: boolean): void {
  quitting = value
}
