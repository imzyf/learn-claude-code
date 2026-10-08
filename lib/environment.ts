// 各章共用宿主环境说明；Node 的 shell: true 在 Windows 使用 cmd.exe。
const WINDOWS_SHELL =
  "Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax";

export const BASH_ENVIRONMENT =
  process.platform === "win32"
    ? WINDOWS_SHELL
    : "Unix-like: the bash tool runs the system shell";

export const TOOL_ENVIRONMENT =
  process.platform === "win32"
    ? `${WINDOWS_SHELL}, and prefer dedicated file tools for file operations`
    : BASH_ENVIRONMENT;

export const WORKFLOW_ENVIRONMENT =
  `Host OS: ${process.platform === "win32" ? "Windows" : "Unix-like"}. ` +
  "This workflow agent only responds to its supplied step; it has no direct shell or file tools.";
