// lib/terminal.ts - 终端输出：ANSI 上色与彩色打印

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
