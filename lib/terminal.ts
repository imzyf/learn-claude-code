// lib/terminal.ts - 终端输出：ANSI 上色与彩色打印

// 全项目配色约定（各 sNN 的 print/colorize 都按这套走）：
//   cyan    — 会话标题/横幅、输入提示符 >>、进行中标记 ▸
//   green   — 助手正式回复/最终输出、欢迎语、tool_use 前的铺垫文字、完成标记 ✓
//   blue    — thinking 推理独白
//   magenta — 子 agent 事件（spawned/done）
//   yellow  — 警告 ⚠、命令回显、任务清单标题
//   red     — 错误 / 权限拦截 ⛔
//   gray    — console 日志输出（hook 调试信息等次要文本）
//   white   — 暂未使用
export type Color =
  | "gray"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white";

const ANSI: Record<Color, string> = {
  gray: "\x1b[38;5;245m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

const RESET = "\x1b[0m";

// Wrap text in an ANSI color code, resetting at the end.
export function colorize(text: string, color: Color): string {
  return `${ANSI[color]}${text}${RESET}`;
}

// console.log with an optional color.
export function print(message = "", color?: Color): void {
  console.log(color ? colorize(message, color) : message);
}
